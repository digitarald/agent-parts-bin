import assert from 'node:assert/strict';
import { test as baseTest } from 'node:test';
import { missing } from '../scripts/examples.mjs';

// Example-only tests: skip every test here when the example's files are gone.
const skip = missing('plugins/json-configuration/dist/server.mjs');
const test = skip ? (name) => baseTest(name, { skip }) : baseTest;

const stdinListeners = process.stdin.listenerCount('data');
const { createServer, getJsonValue, MAX_JSON_LENGTH, TOOL_NAMES, validateJson } =
  skip ? {} : await import('../plugins/json-configuration/dist/server.mjs');

const invalidJson = {
  code: 'INVALID_JSON',
  message: 'JSON input is not valid JSON.'
};
const unsupportedNumericRange = {
  code: 'INVALID_JSON',
  message: 'Unsupported numeric range: JSON numbers must decode to finite JavaScript numbers.'
};
const notFound = {
  code: 'NOT_FOUND',
  message: 'JSON Pointer does not resolve to an existing value.'
};

function assertLookupError(json, pointer, code) {
  const result = getJsonValue(json, pointer);
  assert.equal(result.found, false);
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
}

test('importing the bundle and constructing a server do not start stdio', async () => {
  assert.equal(process.stdin.listenerCount('data'), stdinListeners);
  const server = createServer();
  assert.equal(server.isConnected(), false);
  assert.equal(process.stdin.listenerCount('data'), stdinListeners);
  await server.close();
});

test('tool names are a readonly descriptor for the two registered tools', () => {
  assert.deepEqual(TOOL_NAMES, ['validate_json', 'get_json_value']);
  assert.equal(Object.isFrozen(TOOL_NAMES), true);
});

test('validation identifies every JSON type, including scalars and null', () => {
  for (const [json, type] of [
    ['{}', 'object'],
    ['{"enabled":true}', 'object'],
    ['[]', 'array'],
    ['[1,"two",null]', 'array'],
    ['"hello"', 'string'],
    ['"😀"', 'string'],
    ['0', 'number'],
    ['-2.5e3', 'number'],
    ['true', 'boolean'],
    ['false', 'boolean'],
    ['null', 'null'],
    [' \r\n\t{"nested": [null]}\n ', 'object']
  ]) {
    assert.deepEqual(validateJson(json), { valid: true, type });
  }
});

test('malformed JSON returns stable, input-free errors from both helpers', () => {
  for (const json of [
    '', ' ', '{', '[1,', 'true false', 'NaN', 'Infinity',
    '{"token":"DO_NOT_ECHO_PRIVATE_INPUT",}', "{'key': 1}",
    '{"key":undefined}', '{"key":01}', '\uFEFF{}'
  ]) {
    assert.deepEqual(validateJson(json), { valid: false, error: invalidJson });
    assert.deepEqual(getJsonValue(json, ''), { found: false, error: invalidJson });
  }
});

test('overflowing decoded numbers are rejected throughout the document without echoing input', () => {
  for (const json of [
    '1e400', '-1e400', '1.7976931348623159e308', '9'.repeat(400),
    '[0,null,1e400]', '{"outer":{"values":[false,null,-1e400]}}',
    '{"__proto__":{"value":1e400}}', '{"constructor":1e400}',
    '{"private":"SYNTHETIC_NUMBER_INPUT","safe":null,"overflow":1e400}'
  ]) {
    assert.deepEqual(validateJson(json), { valid: false, error: unsupportedNumericRange });
    for (const pointer of ['', '/safe', '/missing']) {
      assert.deepEqual(getJsonValue(json, pointer), { found: false, error: unsupportedNumericRange });
    }
  }
});

test('finite range boundaries and legitimate null or string values remain supported', () => {
  for (const [json, value] of [
    ['1.7976931348623157e308', Number.MAX_VALUE],
    ['-1.7976931348623157e308', -Number.MAX_VALUE],
    ['5e-324', Number.MIN_VALUE], ['1e-400', 0], ['0', 0], ['-42.5', -42.5]
  ]) {
    assert.deepEqual(validateJson(json), { valid: true, type: 'number' });
    assert.deepEqual(getJsonValue(json, ''), { found: true, value });
  }
  assert.deepEqual(validateJson('null'), { valid: true, type: 'null' });
  assert.deepEqual(getJsonValue('null', ''), { found: true, value: null });
  const json = '{"safe":null,"nested":[1.5,null],"1e400":"-1e400"}';
  assert.deepEqual(validateJson(json), { valid: true, type: 'object' });
  for (const [pointer, value] of [['/safe', null], ['/nested/1', null], ['/1e400', '-1e400']]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
});

test('numeric range checking does not add a recursive nesting limit', () => {
  const depth = 10_000;
  const prefix = '['.repeat(depth);
  const suffix = ']'.repeat(depth);
  assert.deepEqual(validateJson(`${prefix}1e400${suffix}`), {
    valid: false, error: unsupportedNumericRange
  });
  assert.deepEqual(validateJson(`${prefix}null${suffix}`), { valid: true, type: 'array' });
  assert.deepEqual(getJsonValue(`${prefix}null${suffix}`, '/0'.repeat(depth)), { found: true, value: null });
});

test('unexpected parser failures propagate instead of being mislabeled INVALID_JSON', t => {
  const failure = new RangeError('synthetic unexpected parser failure');
  t.mock.method(JSON, 'parse', () => { throw failure; });
  assert.throws(() => validateJson('{}'), error => error === failure);
  assert.throws(() => getJsonValue('{}', ''), error => error === failure);
});

test('empty pointer returns the complete root for every JSON type', () => {
  for (const value of [{ a: [1, null] }, [false, 'value'], 'text', 0, -2.5, true, false, null]) {
    assert.deepEqual(getJsonValue(JSON.stringify(value), ''), { found: true, value });
  }
});

test('RFC 6901 examples resolve punctuation, whitespace, and escaped keys', () => {
  const json = '{"foo":["bar","baz"],"":0,"a/b":1,"c%d":2,"e^f":3,"g|h":4,'
    + '"i\\\\j":5,"k\\"l":6," ":7,"m~n":8}';
  for (const [pointer, value] of [
    ['/foo', ['bar', 'baz']], ['/foo/0', 'bar'], ['/', 0],
    ['/a~1b', 1], ['/c%d', 2], ['/e^f', 3], ['/g|h', 4],
    ['/i\\j', 5], ['/k"l', 6], ['/ ', 7], ['/m~0n', 8]
  ]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
});

test('escapes are decoded once and percent sequences are not URI-decoded', () => {
  const json = JSON.stringify({
    '~1': 'tilde-one', '/': 'slash', '~': 'tilde', '~0': 'tilde-zero',
    'a~/b': { '': 'nested-empty' }, '%2F': 'percent-key'
  });
  for (const [pointer, value] of [
    ['/~01', 'tilde-one'], ['/~1', 'slash'], ['/~0', 'tilde'],
    ['/~00', 'tilde-zero'], ['/a~0~1b/', 'nested-empty'], ['/%2F', 'percent-key']
  ]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
});

test('malformed pointers and invalid escapes are different from missing values', () => {
  for (const pointer of ['key', '#/key', ' ', '/~', '/~2', '/~x', '/key~/', '/missing/~x']) {
    assertLookupError('{}', pointer, 'INVALID_POINTER');
  }
  assert.deepEqual(getJsonValue('{}', '/missing'), { found: false, error: notFound });
  assert.deepEqual(getJsonValue('invalid-json', 'invalid-pointer'), { found: false, error: invalidJson });
});

test('arrays support canonical indices and preserve false, zero, empty string, and null', () => {
  const json = '{"rows":[null,false,0,"",{"nested":[42]}]}';
  for (const [pointer, value] of [
    ['/rows/0', null], ['/rows/1', false], ['/rows/2', 0], ['/rows/3', ''],
    ['/rows/4/nested/0', 42]
  ]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
  for (const pointer of ['/rows/5', '/rows/9007199254740993', `/rows/${'9'.repeat(400)}`]) {
    assertLookupError(json, pointer, 'NOT_FOUND');
  }
});

test('array indices reject leading zeros, signs, fractions, append markers, and properties', () => {
  for (const token of [
    '', '-', '00', '01', '+1', '-0', '-1', '1.0', '1e0', ' 0', '0 ',
    'length', '__proto__', 'constructor', 'toString'
  ]) {
    assertLookupError('[0,1]', `/${token}`, 'INVALID_POINTER');
  }
});

test('object keys need not follow array-index syntax', () => {
  const json = '{"01":"leading-zero","-":"dash","length":3,"":"empty"}';
  for (const [pointer, value] of [
    ['/01', 'leading-zero'], ['/-', 'dash'], ['/length', 3], ['/', 'empty']
  ]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
});

test('missing members and traversal through primitives return NOT_FOUND', () => {
  for (const json of ['null', 'true', 'false', '42', '"text"']) {
    assertLookupError(json, '/0', 'NOT_FOUND');
    assertLookupError(json, '/constructor', 'NOT_FOUND');
  }
  for (const pointer of ['/missing', '/child/missing', '/child/value/next', '/child/value/length']) {
    assertLookupError('{"child":{"value":"text"}}', pointer, 'NOT_FOUND');
  }
  assertLookupError('{"child":null}', '/child/value', 'NOT_FOUND');
});

test('inherited and prototype members are never looked up', () => {
  for (const pointer of [
    '/__proto__', '/constructor', '/toString', '/valueOf',
    '/hasOwnProperty', '/__proto__/constructor', '/constructor/prototype'
  ]) {
    assert.deepEqual(getJsonValue('{}', pointer), { found: false, error: notFound });
  }
});

test('reserved-name keys in the actual JSON are preserved as own data', () => {
  const json = '{"__proto__":{"value":true},"constructor":{"prototype":{"value":42}},'
    + '"prototype":null,"toString":"own","hasOwnProperty":false}';
  for (const [pointer, value] of [
    ['/__proto__', { value: true }], ['/__proto__/value', true],
    ['/constructor/prototype/value', 42], ['/prototype', null],
    ['/toString', 'own'], ['/hasOwnProperty', false]
  ]) {
    assert.deepEqual(getJsonValue(json, pointer), { found: true, value });
  }
  assertLookupError(json, '/__proto__/constructor', 'NOT_FOUND');
});

test('the exact JSON input limit is accepted by both helpers', () => {
  assert.equal(MAX_JSON_LENGTH, 1_048_576);
  const value = 'a'.repeat(MAX_JSON_LENGTH - 2);
  const json = JSON.stringify(value);
  assert.equal(json.length, MAX_JSON_LENGTH);
  assert.deepEqual(validateJson(json), { valid: true, type: 'string' });
  assert.deepEqual(getJsonValue(json, ''), { found: true, value });
});

test('oversized JSON is rejected before parsing, with an explicit input-free error', () => {
  const error = {
    code: 'INVALID_JSON',
    message: 'JSON input exceeds the maximum of 1,048,576 characters (UTF-16 code units).'
  };
  for (const json of [
    `"${'a'.repeat(MAX_JSON_LENGTH - 1)}"`,
    'DO_NOT_ECHO'.padEnd(MAX_JSON_LENGTH + 1, 'x')
  ]) {
    assert.deepEqual(validateJson(json), { valid: false, error });
    assert.deepEqual(getJsonValue(json, ''), { found: false, error });
  }
});

test('the input limit counts UTF-16 code units consistently with the Zod schema', () => {
  const json = JSON.stringify('😀'.repeat((MAX_JSON_LENGTH - 2) / 2));
  assert.equal(json.length, MAX_JSON_LENGTH);
  assert.deepEqual(validateJson(json), { valid: true, type: 'string' });
  assert.equal(validateJson(`${json} `).error.code, 'INVALID_JSON');
});

test('JavaScript callers cannot bypass string argument validation in the helpers', () => {
  for (const value of [null, undefined, true, 42, {}, []]) {
    assert.equal(validateJson(value).error.code, 'INVALID_JSON');
    assert.equal(getJsonValue(value, '').error.code, 'INVALID_JSON');
    assert.equal(getJsonValue('{}', value).error.code, 'INVALID_POINTER');
  }
});
