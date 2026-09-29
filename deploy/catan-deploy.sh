#!/usr/bin/env bash
set -euo pipefail

umask 022

base=/srv/catan
repository=https://github.com/ButaFor/catan-web.git
remote_commit=$(git ls-remote --exit-code "$repository" refs/heads/main | cut -f1)

[[ $remote_commit =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Unable to read main commit' >&2
  exit 1
}

if [[ $(readlink "$base/current" 2>/dev/null || true) == "releases/$remote_commit" ]]; then
  exit 0
fi

build_dir=$(mktemp -d "$base/.build.XXXXXXXX")
trap 'rm -rf -- "$build_dir"' EXIT

git clone --quiet --depth 1 --single-branch --branch main "$repository" "$build_dir/repo"
[[ $(git -C "$build_dir/repo" rev-parse HEAD) == "$remote_commit" ]] || {
  echo 'main changed during fetch; retry on next run' >&2
  exit 1
}

if [[ ! -f $build_dir/repo/index.html ]]; then
  echo 'main has no index.html yet; waiting for the first release'
  exit 0
fi
mkdir "$build_dir/release"
install -m 0644 "$build_dir/repo/index.html" "$build_dir/release/index.html"

if [[ ! -d $base/releases/$remote_commit ]]; then
  mv -- "$build_dir/release" "$base/releases/$remote_commit"
fi

ln -s "releases/$remote_commit" "$base/.current-next-$$"
mv -Tf -- "$base/.current-next-$$" "$base/current"
echo "Deployed $remote_commit"
