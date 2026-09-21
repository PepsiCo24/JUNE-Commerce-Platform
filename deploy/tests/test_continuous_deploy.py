"""Exercise deployment guards with local Git repos; no server or Docker required."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy/scripts/continuous-deploy.sh'


class ContinuousDeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.source = self.root / 'source'
        self.server = self.root / 'server'
        self.run_cmd('git', 'init', '--bare', str(self.remote))
        self.run_cmd('git', 'init', '-b', 'main', str(self.source))
        self.git(self.source, 'config', 'user.email', 'test@example.test')
        self.git(self.source, 'config', 'user.name', 'Test')
        (self.source / 'deploy/scripts').mkdir(parents=True)
        (self.source / '.gitignore').write_text('.env\ndeploy/.state/\n')
        (self.source / 'deploy/scripts/deploy.sh').write_text(
            '#!/usr/bin/env bash\nset -eu\n'
            'printf "%s" "$JUNE_IMAGE_TAG" > deploy/.state/called\n'
            'if [ "${FAKE_STARTED:-0}" = 1 ]; then touch "$JUNE_DEPLOY_STARTED_FILE"; fi\n'
            'exit "${FAKE_DEPLOY_EXIT:-0}"\n')
        (self.source / 'version').write_text('old')
        (self.source / 'docker-compose.yml').write_text('old-compose')
        self.git(self.source, 'add', '.')
        self.git(self.source, 'commit', '-m', 'old')
        self.old = self.git(self.source, 'rev-parse', 'HEAD').strip()
        self.git(self.source, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.source, 'push', '-u', 'origin', 'main')
        self.run_cmd('git', 'clone', '-b', 'main', str(self.remote), str(self.server))
        (self.server / '.env').write_text('PRIVATE_VALUE=keep-me\n')
        (self.server / 'deploy/.state').mkdir()
        (self.server / 'deploy/.state/current-image-tag').write_text('old-tag')
        (self.source / 'version').write_text('new')
        (self.source / 'docker-compose.yml').write_text('new-compose')
        self.git(self.source, 'commit', '-am', 'new')
        self.new = self.git(self.source, 'rev-parse', 'HEAD').strip()
        self.git(self.source, 'push')
        self.env = os.environ.copy()
        bindir = self.root / 'bin'
        bindir.mkdir()
        docker = bindir / 'docker'
        docker.write_text('#!/bin/sh\nprintf "%s:" "$JUNE_IMAGE_TAG" > deploy/.state/recovery\ncat docker-compose.yml >> deploy/.state/recovery\n')
        docker.chmod(0o755)
        self.env['PATH'] = str(bindir) + ':' + self.env['PATH']
        if not shutil.which('flock'):
            # macOS local checks exercise Git guards only; Linux CI uses real flock.
            stub = bindir / 'flock'
            stub.write_text('#!/bin/sh\nexit 0\n')
            stub.chmod(0o755)

    def run_cmd(self, *args, cwd=None):
        return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE, text=True)

    def git(self, cwd, *args):
        return self.run_cmd('git', *args, cwd=cwd)

    def deploy(self, sha=None):
        return subprocess.run(
            ['bash', str(SCRIPT), str(self.server), sha or self.new, 'ghcr.io/test/june'],
            env=self.env, text=True, capture_output=True)

    def test_updates_exact_commit_preserves_env(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git(self.server, 'rev-parse', 'HEAD').strip(), self.new)
        self.assertEqual((self.server / 'deploy/.state/called').read_text(), self.new)
        self.assertEqual((self.server / '.env').read_text(), 'PRIVATE_VALUE=keep-me\n')

    def test_dirty_checkout_refuses_deploy(self):
        (self.server / 'version').write_text('server-local-change')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('uncommitted', result.stderr)
        self.assertFalse((self.server / 'deploy/.state/called').exists())

    def test_stale_run_does_not_downgrade_server(self):
        result = self.deploy(self.old)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Skipping stale', result.stdout)
        self.assertFalse((self.server / 'deploy/.state/called').exists())

    def test_failure_restores_code_and_returns_failure(self):
        self.env['FAKE_DEPLOY_EXIT'] = '42'
        result = self.deploy()
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual(self.git(self.server, 'rev-parse', 'HEAD').strip(), self.old)

    def test_rejects_non_sha(self):
        result = self.deploy('main;bad')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.server / 'deploy/.state/called').exists())

    def test_failed_switch_restores_old_compose_and_image(self):
        self.env.update(FAKE_DEPLOY_EXIT='42', FAKE_STARTED='1')
        result = self.deploy()
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertEqual((self.server / 'deploy/.state/recovery').read_text(), 'old-tag:old-compose')


class DeploymentStateTest(unittest.TestCase):
    def test_compose_function_failure_triggers_deploy_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state').mkdir()
            (root / 'state/current-image-tag').write_text('old-tag')
            (root / '.env').write_text('PUBLIC_WEB_ORIGIN=https://unused.test\n')
            bindir = root / 'bin'
            bindir.mkdir()
            docker = bindir / 'docker'
            docker.write_text('''#!/bin/bash
printf '%s %s\\n' "$JUNE_IMAGE_TAG" "$*" >> "$DOCKER_CALLS"
if [[ "$JUNE_IMAGE_TAG" == new-tag && "$*" == *"up -d --no-deps api" ]]; then exit 42; fi
if [[ "$*" == *"{{.Health}}"* ]]; then echo healthy; fi
exit 0
''')
            docker.chmod(0o755)
            (bindir / 'sleep').write_text('#!/bin/sh\nexit 0\n')
            (bindir / 'sleep').chmod(0o755)
            env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'],
                       JUNE_ENV_FILE=str(root / '.env'), JUNE_STATE_DIR=str(root / 'state'),
                       JUNE_LOG_DIR=str(root / 'logs'), JUNE_IMAGE_TAG='new-tag',
                       SKIP_BACKUP='1', NO_ROLLBACK='0', DOCKER_CALLS=str(root / 'calls'))
            result = subprocess.run(['bash', str(ROOT / 'deploy/scripts/deploy.sh')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 42, result.stderr)
            calls = (root / 'calls').read_text().splitlines()
            self.assertTrue(any(line.startswith('old-tag ') and 'up -d --no-deps worker api web' in line
                                for line in calls), calls)

    def test_success_persists_version_without_changing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / '.env'
            env_file.write_text('SECRET="keep $literal"\nJUNE_IMAGE_TAG=old\nJUNE_IMAGE_PREFIX=old/prefix\n')
            env_file.chmod(0o600)
            env = dict(os.environ, JUNE_ENV_FILE=str(env_file), JUNE_STATE_DIR=str(root / 'state'),
                       JUNE_LOG_DIR=str(root / 'logs'), JUNE_IMAGE_PREFIX='ghcr.io/test/june')
            result = subprocess.run(['bash', '-c', 'source "$1"; record_tag new', '_',
                                     str(ROOT / 'deploy/scripts/_common.sh')], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('SECRET="keep $literal"', env_file.read_text())
            self.assertIn('JUNE_IMAGE_TAG=new', env_file.read_text())
            self.assertIn('JUNE_IMAGE_PREFIX=ghcr.io/test/june', env_file.read_text())
            self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
