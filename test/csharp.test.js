import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripComments,
  findMatching,
  splitTopLevel,
  unquote,
  literalValue,
  parseChain,
  lambdaBody,
  simpleName,
} from '../src/csharp.js';

test('stripComments removes line and block comments but keeps strings', () => {
  const code = 'var a = "http://x"; // trailing\n/* block */ var b = 2;';
  const out = stripComments(code);
  assert.ok(out.includes('"http://x"'));
  assert.ok(!out.includes('trailing'));
  assert.ok(!out.includes('block'));
  assert.ok(out.includes('var b = 2;'));
});

test('findMatching balances nested braces and ignores strings', () => {
  const code = 'f(a, "cl)ose", (b + c))';
  assert.equal(findMatching(code, 1), code.length - 1);
});

test('splitTopLevel splits only at depth zero', () => {
  const parts = splitTopLevel('a, f(b, c), "x,y", d', ',');
  assert.deepEqual(parts.map((p) => p.trim()), ['a', 'f(b, c)', '"x,y"', 'd']);
});

test('unquote handles escaped and verbatim strings', () => {
  assert.equal(unquote('"nvarchar(200)"'), 'nvarchar(200)');
  assert.equal(unquote('@"C:\\temp"'), 'C:\\temp');
  assert.equal(unquote('"say \\"hi\\""'), 'say "hi"');
});

test('literalValue converts C# literals', () => {
  assert.equal(literalValue('true'), true);
  assert.equal(literalValue('false'), false);
  assert.equal(literalValue('null'), null);
  assert.equal(literalValue('18'), 18);
  assert.equal(literalValue('2.5m'), 2.5);
  assert.equal(literalValue('"x"'), 'x');
});

test('parseChain parses a fluent property chain', () => {
  const chain = parseChain('b.Property<string>("Name").IsRequired().HasMaxLength(200)');
  assert.equal(chain.root, 'b');
  assert.deepEqual(chain.calls.map((c) => c.name), ['Property', 'IsRequired', 'HasMaxLength']);
  assert.equal(chain.calls[0].generic, 'string');
  assert.deepEqual(chain.calls[0].args, ['"Name"']);
  assert.deepEqual(chain.calls[2].args, ['200']);
});

test('parseChain handles lambda arguments', () => {
  const chain = parseChain('b.OwnsOne("Ns.Address", "Address", b1 => { b1.HasKey("Id"); })');
  assert.equal(chain.calls[0].name, 'OwnsOne');
  assert.equal(chain.calls[0].args.length, 3);
  assert.ok(chain.calls[0].args[2].includes('=>'));
});

test('lambdaBody extracts block body', () => {
  assert.equal(lambdaBody('b1 => { x; y; }').trim(), 'x; y;');
  assert.equal(lambdaBody('not a lambda'), null);
});

test('simpleName shortens qualified and nested names', () => {
  assert.equal(simpleName('WebShop.Models.Product'), 'Product');
  assert.equal(simpleName('Ns.Outer+Inner'), 'Inner');
  assert.equal(simpleName('Plain'), 'Plain');
});
