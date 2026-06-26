const path = require('path');

const FIXTURES_ROOT = path.join(__dirname, '..', '..');
const TRICKY_ROOT = path.join(FIXTURES_ROOT, 'tricky');

function trickyPath(...parts) {
    return path.join(TRICKY_ROOT, ...parts);
}

module.exports = { FIXTURES_ROOT, TRICKY_ROOT, trickyPath };
