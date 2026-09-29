export class AuthenticationError extends Error {
  public readonly code = "AUTHENTICATION_REQUIRED";

  public constructor(message = "Authentication is required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class OAuthConfigurationError extends Error {
  public readonly code = "OAUTH_NOT_CONFIGURED";

  public constructor() {
    super("Google OAuth is not configured");
    this.name = "OAuthConfigurationError";
  }
}

export class InvalidCredentialsError extends Error {
  public readonly code = "INVALID_CREDENTIALS";

  public constructor() {
    super("Invalid username or password");
    this.name = "InvalidCredentialsError";
  }
}

export class UsernameTakenError extends Error {
  public readonly code = "USERNAME_TAKEN";

  public constructor() {
    super("Username is already taken");
    this.name = "UsernameTakenError";
  }
}
