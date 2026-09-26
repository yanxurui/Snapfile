import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('compression and immutable caching are scoped to hashed JS/CSS, with HTML revalidation', () => {
  const config = readFileSync(new URL('../../deploy/snapfile.conf', import.meta.url), 'utf8');
  const match = config.match(/location ~ "([^"]+)" \{([^}]+)\}/);
  assert(match);
  const [, pattern, directives] = match;
  const path = new RegExp(pattern);
  for (const name of ['/assets/main-HQYSmZOi.js', '/assets/login-BFZM8j53.css']) assert(path.test(name));
  for (const name of ['/login.html', '/index.html', '/files', '/ws', '/download/1/a/1', '/assets/plain.js']) {
    assert(!path.test(name));
  }
  assert.match(directives, /gzip on;/);
  assert.match(directives, /gzip_types application\/javascript text\/css;/);
  assert.match(directives, /gzip_vary on;/);
  assert.match(directives, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.equal((config.match(/gzip on;/g) || []).length, 1);
  for (const page of ['login', 'index']) {
    assert.match(config, new RegExp(`location = /${page}\\.html \\{\\s*add_header Cache-Control "no-cache";`));
  }
});
