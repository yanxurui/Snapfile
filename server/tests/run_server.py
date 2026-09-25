"""Launch a backend with private test resources, without runtime env overrides."""
import argparse
import os
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=['TEST', 'E2E'], required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--redis-port', type=int, required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--x-accel-redirect', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.redis_port <= 65535:
        parser.error('Ports must be between 1 and 65535')
    directory = args.directory.resolve(strict=True)
    if not directory.is_dir():
        parser.error('--directory must be an existing private test directory')
    os.environ['ENV'] = args.environment
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from snapfile import config
    config.PORT = args.port
    config.REDIS_ADDRESS = 'redis://127.0.0.1:{}'.format(args.redis_port)
    config.UPLOAD_ROOT_DIRECTORY = str(directory / 'uploads')
    config.LOG_FILE = str(directory / 'backend.log')
    config.USE_X_ACCEL_REDIRECT = args.x_accel_redirect
    from snapfile.__main__ import main as run
    run()


if __name__ == '__main__':
    main()
