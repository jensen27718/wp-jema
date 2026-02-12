from __future__ import annotations

import getpass

from app.auth import build_password_hash


def main() -> None:
    password = getpass.getpass("Password: ")
    if not password:
        raise SystemExit("Password cannot be empty")
    print(build_password_hash(password))


if __name__ == "__main__":
    main()
