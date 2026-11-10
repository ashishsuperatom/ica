// The engine's mode (mode.ts): the project's engine by default; a cell only for a person it names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modeOf } from '../mode.ts'

test("the project's engine unless told otherwise; a cell names its person; anything else refused", () => {
  assert.deepEqual(modeOf({}), { mode: 'project', person: null })
  assert.deepEqual(modeOf({ SA_ENGINE_MODE: 'project', SA_CELL_PERSON: 'ana@x.io' }), { mode: 'project', person: null })
  assert.deepEqual(modeOf({ SA_ENGINE_MODE: 'Cell', SA_CELL_PERSON: ' Ana@X.io ' }), { mode: 'cell', person: 'ana@x.io' })
  assert.throws(() => modeOf({ SA_ENGINE_MODE: 'cell' }), /set SA_CELL_PERSON to their email/)
  assert.throws(() => modeOf({ SA_ENGINE_MODE: 'cell', SA_CELL_PERSON: 'ana' }), /set SA_CELL_PERSON/)
  assert.throws(() => modeOf({ SA_ENGINE_MODE: 'task' }), /SA_ENGINE_MODE is "task"/)
})
