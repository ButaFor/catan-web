CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  is_guest boolean NOT NULL,
  username text CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{3,30}$'),
  email text CHECK (email IS NULL OR (email = lower(btrim(email)) AND length(email) > 0)),
  email_verified boolean NOT NULL DEFAULT false,
  password_hash text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_guest_credentials CHECK (NOT is_guest OR (username IS NULL AND email IS NULL AND password_hash IS NULL AND NOT email_verified)),
  CHECK (NOT email_verified OR email IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_unique ON users (lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE email IS NOT NULL;

CREATE TABLE oauth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (length(provider) > 0),
  provider_account_id text NOT NULL CHECK (length(provider_account_id) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_accounts_provider_unique UNIQUE (provider, provider_account_id)
);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts(user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE rooms (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code = upper(btrim(code)) AND length(code) BETWEEN 1 AND 32),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
  capacity smallint NOT NULL CHECK (capacity > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_rules jsonb NOT NULL CHECK (jsonb_typeof(current_rules) = 'object'),
  rules_schema_version integer NOT NULL CHECK (rules_schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE room_members (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ready boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_members_user_idx ON room_members(user_id);
ALTER TABLE rooms ADD CONSTRAINT rooms_host_member_fk
  FOREIGN KEY (id, host_user_id) REFERENCES room_members(room_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE games (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('created', 'active', 'finished')),
  rules_snapshot jsonb NOT NULL CHECK (jsonb_typeof(rules_snapshot) = 'object'),
  rules_schema_version integer NOT NULL CHECK (rules_schema_version > 0),
  current_state jsonb NOT NULL CHECK (jsonb_typeof(current_state) = 'object'),
  state_schema_version integer NOT NULL CHECK (state_schema_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  last_sequence_number integer NOT NULL DEFAULT 0 CHECK (last_sequence_number >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'finished') = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX games_one_open_per_room ON games(room_id) WHERE status IN ('created', 'active');
CREATE INDEX games_room_history_idx ON games(room_id, created_at DESC, id);

CREATE TABLE game_players (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  color text NOT NULL CHECK (length(color) > 0),
  turn_order integer NOT NULL CHECK (turn_order >= 0),
  UNIQUE (game_id, id),
  UNIQUE (game_id, user_id),
  UNIQUE (game_id, color),
  UNIQUE (game_id, turn_order)
);
CREATE INDEX game_players_user_idx ON game_players(user_id);

CREATE TABLE game_events (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  game_version integer NOT NULL CHECK (game_version > 0),
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]*$'),
  actor_player_id uuid,
  audience text NOT NULL CHECK (audience IN ('public', 'player', 'server')),
  recipient_player_id uuid,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_schema_version integer NOT NULL CHECK (payload_schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, sequence_number),
  FOREIGN KEY (game_id, actor_player_id) REFERENCES game_players(game_id, id),
  FOREIGN KEY (game_id, recipient_player_id) REFERENCES game_players(game_id, id),
  CHECK ((audience = 'player') = (recipient_player_id IS NOT NULL))
);
CREATE INDEX game_events_transition_idx ON game_events(game_id, game_version);

-- Historical rules are immutable even if application code tries to change them.
CREATE FUNCTION protect_game_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rules_snapshot IS DISTINCT FROM OLD.rules_snapshot
     OR NEW.rules_schema_version IS DISTINCT FROM OLD.rules_schema_version
     OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    RAISE EXCEPTION 'Game identity and rules snapshot are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'finished' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Finished games are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER games_history_guard BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION protect_game_history();

-- Check the final transaction state, permitting atomic start/finish in either write order.
CREATE FUNCTION check_room_game_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; room_status text; open_count integer;
BEGIN
  IF TG_TABLE_NAME = 'rooms' THEN
    target_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_id := COALESCE(NEW.room_id, OLD.room_id);
  END IF;
  SELECT status INTO room_status FROM rooms WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO open_count FROM games
    WHERE room_id = target_id AND status IN ('created', 'active');
  IF (room_status = 'active' AND open_count <> 1)
     OR (room_status <> 'active' AND open_count <> 0) THEN
    RAISE EXCEPTION 'Room and game lifecycle disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER rooms_lifecycle_guard AFTER INSERT OR UPDATE ON rooms
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_room_game_lifecycle();
CREATE CONSTRAINT TRIGGER games_lifecycle_guard AFTER INSERT OR UPDATE OR DELETE ON games
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_room_game_lifecycle();
