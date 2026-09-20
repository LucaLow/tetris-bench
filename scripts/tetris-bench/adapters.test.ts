import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_VERSION,
  EVIDENCE_SYSTEM_PROMPT,
  REPLY_INSTRUCTION,
  ProviderError,
  builtInBrains,
  candidateLine,
  chatRequestBody,
  hostedBrain,
  jevBrain,
  jevMemory,
  normaliseChoiceProbabilities,
  openRouterBrain,
  parseReply,
  renderEvidence,
} from '../../lib/tetris-bench/adapters.ts';
import { HOSTED_MODELS, findHostedModel } from '../../lib/tetris-bench/models.ts';
import type { HostedModel } from '../../lib/tetris-bench/models.ts';
import { applyHold, createGame } from '../../lib/tetris-bench/engine.ts';
import { inputFor } from '../../lib/tetris-bench/harness.ts';
import { validateAnswer } from '../../lib/tetris-bench/contract.ts';
import type { AgentAnswer, AgentInput } from '../../lib/tetris-bench/contract.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };
type FetchHandler = (call: FetchCall, index: number) => Response | Promise<Response>;

/** Stubs global fetch for the duration of `run` and returns every request it saw. */
async function withFetch(handler: FetchHandler, run: () => Promise<void>): Promise<FetchCall[]> {
  const previous = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function chatReply(content: string, extra: { finishReason?: string; cost?: number; reasoningTokens?: number } = {}): Response {
  return json({
    choices: [{ message: { role: 'assistant', content }, finish_reason: extra.finishReason ?? 'stop' }],
    usage: {
      prompt_tokens: 1234,
      completion_tokens: 9,
      completion_tokens_details: { reasoning_tokens: extra.reasoningTokens ?? 0 },
      cost: extra.cost ?? 0.0011,
    },
  });
}

function context(budgetMs: number | null = 20_000, signal = new AbortController().signal) {
  return { signal, budgetMs };
}

/** Two full rows with a two-wide gap and an O piece: exactly one candidate clears two lines. */
function fixture(side: 'left' | 'right'): AgentInput {
  const state = createGame(`diagnostic-${side}`);
  state.active = { type: 'O', rotation: 0, x: 3, y: -1 };
  state.holdUsed = true;
  const gap = side === 'left' ? 0 : 8;
  for (const y of [18, 19]) {
    for (let x = 0; x < 10; x++) state.board[y][x] = x === gap || x === gap + 1 ? null : 'J';
  }
  return inputFor(state, 'IQ');
}

function model(slug: string): HostedModel {
  const found = findHostedModel(slug);
  if (!found) throw new Error(`unknown model ${slug}`);
  return found;
}

const GPT = () => model('gpt-4o-mini');

function asAnswer(value: unknown): AgentAnswer {
  assert.ok(value && typeof value === 'object', 'answer is an object');
  return value as AgentAnswer;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry lists the seven entrants with their measured settings', () => {
  assert.equal(HOSTED_MODELS.length, 7);
  assert.equal(new Set(HOSTED_MODELS.map(m => m.slug)).size, 7);
  assert.equal(model('jev').kind, 'classifier');
  assert.equal(model('jev').model, 'typesafe/jev-1.13');
  assert.deepEqual([model('gpt-4o-mini').temperature, model('gpt-4o-mini').maxTokens, model('gpt-4o-mini').reasoning], [0, 80, undefined]);
  assert.deepEqual([model('gpt-5.6-luna').temperature, model('gpt-5.6-luna').reasoning, model('gpt-5.6-luna').maxTokens], [undefined, 'off', 80]);
  assert.deepEqual([model('gemini-3.5-flash-lite').temperature, model('gemini-3.5-flash-lite').reasoning, model('gemini-3.5-flash-lite').maxTokens], [0, 'none', 400]);
  assert.deepEqual([model('deepseek-v4-flash').reasoning, model('deepseek-v4-flash').maxTokens], ['off', 80]);
  assert.deepEqual([model('qwen3.7-flash').reasoning, model('qwen3.7-flash').maxTokens], ['off', 80]);
  assert.deepEqual([model('claude-haiku-4.5').jsonSchema, model('claude-haiku-4.5').maxTokens, model('claude-haiku-4.5').temperature], [true, 80, 0]);
  for (const entry of HOSTED_MODELS) assert.notEqual(entry.jsonSchema, false, `${entry.slug} uses the strict schema`);
});

// ---------------------------------------------------------------------------
// Built-in brains
// ---------------------------------------------------------------------------

test('built-in brains decide from the public input only and carry the adapter version', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  const kinds: Record<string, string> = {};
  for (const brain of builtInBrains) {
    const raw = await brain.decide(structuredClone(input), context());
    assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'ok', brain.slug);
    assert.equal(brain.adapterVersion, ADAPTER_VERSION);
    kinds[brain.slug] = brain.kind;
  }
  assert.deepEqual(kinds, { 'random-legal': 'baseline', greedy: 'heuristic', dellacherie: 'heuristic', search: 'search' });
});

test('every heuristic takes the unique two-line clear on both fixtures', async () => {
  for (const side of ['left', 'right'] as const) {
    const input = fixture(side);
    const twoLiner = input.candidates.filter(c => c.linesCleared === 2);
    assert.equal(twoLiner.length, 1);
    for (const brain of builtInBrains.filter(b => b.slug !== 'random-legal')) {
      const checked = validateAnswer(await brain.decide(structuredClone(input), context()), input.stateHash, input.legal, input.canHold);
      assert.equal(checked.status, 'ok');
      if (checked.status === 'ok') assert.deepEqual(checked.placement, twoLiner[0].placement, `${brain.slug} ${side}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Evidence rendering
// ---------------------------------------------------------------------------

test('renderEvidence: non-ordinal ids, split points, occupied rows plus one empty row', () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  assert.equal(evidence.system, EVIDENCE_SYSTEM_PROMPT);
  assert.ok(evidence.system.includes('probability (0-1) that the game tops out within the next ten pieces'));
  assert.ok(evidence.system.includes('Both are optional'));

  const ids = [...evidence.ids.keys()];
  assert.equal(ids.length, input.candidates.length);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const id of ids) {
    assert.match(id, /^[A-Z]{2}$/, 'two uppercase letters');
    assert.doesNotMatch(id, /^p\d+$/, 'no ordinal id');
  }
  assert.deepEqual([...renderEvidence(input).ids.keys()], ids, 'ids are deterministic for a state');
  const other = renderEvidence(fixture('right'));
  assert.notDeepEqual([...other.ids.keys()], ids, 'ids depend on the state hash');

  const [header, board, candidates, reply] = evidence.user.split('\n\n');
  assert.equal(header, 'Active piece: O   Next: ' + input.next.join(' ') + '   Hold slot: empty (canHold=false)   Level 1, score 0, lines 0, pieces 0, combo -1, back-to-back false');
  assert.equal(board, [
    'Current board (rows 17-19 shown; rows above 17 are empty):',
    '17 ..........',
    '18 ..########',
    '19 ..########',
    '   0123456789',
    'Column heights now: [0,0,2,2,2,2,2,2,2,2]  holes now: 0  maxH now: 2',
  ].join('\n'));
  const lines = candidates.split('\n');
  assert.equal(lines[0], `Candidates (${input.candidates.length}):`);
  const pattern = /^([A-Z]{2}): x=-?\d+ rot=[0-3] \| lines=\d clear=\+\d+ drop=\+\d+ maxH=\d+ holes=\d+ bump=\d+ wells=\d+ topOut=(yes|no)$/;
  for (const line of lines.slice(1)) assert.match(line, pattern);
  assert.equal(lines.length - 1, input.candidates.length);
  const clearing = input.candidates.find(c => c.linesCleared === 2);
  assert.ok(clearing);
  const clearingId = ids.find(id => evidence.ids.get(id) === clearing);
  assert.ok(clearingId);
  assert.ok(lines.includes(`${clearingId}: x=${clearing.placement.x} rot=${clearing.placement.rotation} | lines=2 clear=+1500 drop=+38 maxH=0 holes=0 bump=0 wells=0 topOut=no`));
  assert.equal(reply, REPLY_INSTRUCTION);
  assert.ok(reply.includes('JSON'));
});

test('renderEvidence on an empty board shows only the floor row', () => {
  const input = inputFor(createGame('test'), 'IQ');
  const evidence = renderEvidence(input);
  assert.ok(evidence.user.includes('Current board (rows 19-19 shown; rows above 19 are empty):\n19 ..........\n   0123456789\n'));
  assert.ok(evidence.user.includes('Hold slot: empty (canHold=true)'));
});

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

test('chat completions: request body shape, strict schema enum, usage accounting and the mapped answer', async () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  const ids = [...evidence.ids.keys()];
  const pickId = ids[3];
  let raw: unknown;
  const calls = await withFetch(() => chatReply(JSON.stringify({ candidate: pickId }), { cost: 0.002, reasoningTokens: 5 }), async () => {
    raw = await openRouterBrain(GPT(), { key: 'test-key' }).decide(input, context());
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer test-key');
  assert.equal(call.body.model, 'openai/gpt-4o-mini');
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: evidence.system },
    { role: 'user', content: evidence.user },
  ]);
  assert.deepEqual(call.body.usage, { include: true });
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.max_tokens, 80);
  assert.equal('reasoning' in call.body, false);
  assert.deepEqual(call.body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'tetris_choice',
      strict: true,
      schema: {
        type: 'object',
        properties: { candidate: { type: 'string', enum: ids }, hold: { type: 'boolean' }, risk: { type: 'number' } },
        required: ['candidate', 'hold', 'risk'],
        additionalProperties: false,
      },
    },
  });
  const answer = asAnswer(raw);
  assert.deepEqual(answer.choice, [{ ...evidence.ids.get(pickId)!.placement, p: 1 }]);
  assert.equal(answer.costUsd, 0.002);
  assert.deepEqual(answer.meta, { promptTokens: 1234, completionTokens: 9, reasoningTokens: 5, finishReason: 'stop', retries: 0 });
  assert.equal(answer.noul, undefined);
  assert.equal(answer.score, undefined);
  assert.ok(!JSON.stringify(raw).includes('test-key'));
  const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
  assert.equal(checked.status, 'ok');
  if (checked.status === 'ok') assert.deepEqual(checked.placement, evidence.ids.get(pickId)!.placement);
});

test('chat completions: json_object fallback keeps the word JSON in the messages', () => {
  const input = fixture('right');
  const evidence = renderEvidence(input);
  const looseModel: HostedModel = { ...GPT(), slug: 'loose', jsonSchema: false };
  const body = chatRequestBody(looseModel, evidence);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const messages = body.messages as Array<{ content: string }>;
  assert.ok(messages.some(message => message.content.includes('JSON')));
});

test('chat completions: per-model temperature, reasoning and token settings', async () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  const pick = JSON.stringify({ candidate: [...evidence.ids.keys()][0] });
  const bodies: Record<string, Record<string, unknown>> = {};
  await withFetch(call => { bodies[String(call.body.model)] = call.body; return chatReply(pick); }, async () => {
    for (const entry of HOSTED_MODELS.filter(m => m.kind === 'llm')) {
      const raw = await openRouterBrain(entry, { key: 'k' }).decide(input, context());
      assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'ok', entry.slug);
    }
  });
  const settings = (id: string) => {
    const body = bodies[id];
    return { temperature: body.temperature, reasoning: body.reasoning, maxTokens: body.max_tokens, format: (body.response_format as { type: string }).type };
  };
  assert.deepEqual(settings('openai/gpt-4o-mini'), { temperature: 0, reasoning: undefined, maxTokens: 80, format: 'json_schema' });
  assert.deepEqual(settings('openai/gpt-5.6-luna'), { temperature: undefined, reasoning: { enabled: false }, maxTokens: 80, format: 'json_schema' });
  assert.deepEqual(settings('google/gemini-3.5-flash-lite'), { temperature: 0, reasoning: undefined, maxTokens: 400, format: 'json_schema' });
  assert.deepEqual(settings('deepseek/deepseek-v4-flash'), { temperature: 0, reasoning: { enabled: false }, maxTokens: 80, format: 'json_schema' });
  assert.deepEqual(settings('qwen/qwen3.7-flash'), { temperature: 0, reasoning: { enabled: false }, maxTokens: 80, format: 'json_schema' });
  assert.deepEqual(settings('anthropic/claude-haiku-4.5'), { temperature: 0, reasoning: undefined, maxTokens: 80, format: 'json_schema' });
  assert.equal('temperature' in bodies['openai/gpt-5.6-luna'], false);
  assert.equal('reasoning' in bodies['google/gemini-3.5-flash-lite'], false);
});

test('lenient parsing accepts fenced, prose-wrapped and duplicated JSON', async () => {
  assert.deepEqual(parseReply('```json\n{"candidate":"LF"}\n```\n\nThe candidate LF keeps the stack flat.'), { candidate: 'LF' });
  assert.deepEqual(parseReply('{"candidate":"LF"}\n\n\n{"candidate":"LF"}\n'), { candidate: 'LF' });
  assert.deepEqual(parseReply('Sure! {"candidate": "kx", "hold": false, "risk": 0.2}'), { candidate: 'kx', hold: false, risk: 0.2 });
  assert.equal(parseReply('no object here'), null);
  assert.equal(parseReply('{"candidate": '), null);
  assert.equal(parseReply(''), null);

  const input = fixture('left');
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  const replies = [
    '```json\n{"candidate":"' + id + '"}\n```\nBecause it is flat.',
    `{"candidate":"${id}"}\n\n{"candidate":"${id}"}`,
    `{"candidate":"${id.toLowerCase()}"}`,
  ];
  let index = 0;
  await withFetch(() => chatReply(replies[index++]), async () => {
    for (let i = 0; i < replies.length; i++) {
      const raw = await openRouterBrain(GPT(), { key: 'k' }).decide(input, context());
      const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
      assert.equal(checked.status, 'ok', replies[i]);
      if (checked.status === 'ok') assert.deepEqual(checked.placement, evidence.ids.get(id)!.placement);
    }
  });
});

test('finish_reason length is unusable but still reports the cost and the reason', async () => {
  const input = fixture('left');
  let raw: unknown;
  await withFetch(() => chatReply('', { finishReason: 'length', cost: 0.0007, reasoningTokens: 80 }), async () => {
    raw = await openRouterBrain(model('deepseek-v4-flash'), { key: 'k' }).decide(input, context());
  });
  const answer = asAnswer(raw);
  assert.deepEqual(answer.choice, []);
  assert.equal(answer.costUsd, 0.0007);
  assert.equal(answer.meta?.finishReason, 'length');
  assert.equal(answer.meta?.reasoningTokens, 80);
  assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'invalid');
});

test('an unknown candidate id is unusable, keeps the cost and records the raw content', async () => {
  const input = fixture('left');
  let raw: unknown;
  await withFetch(() => chatReply('{"candidate":"ZZ9"}', { cost: 0.0004 }), async () => {
    raw = await openRouterBrain(GPT(), { key: 'k' }).decide(input, context());
  });
  const answer = asAnswer(raw);
  assert.deepEqual(answer.choice, []);
  assert.equal(answer.costUsd, 0.0004);
  assert.equal(answer.meta?.raw, '{"candidate":"ZZ9"}');
  assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'invalid');
});

test('boolean hold and numeric risk are forwarded', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  assert.equal(input.canHold, true);
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  let raw: unknown;
  await withFetch(() => chatReply(JSON.stringify({ candidate: id, hold: true, risk: 0.3 })), async () => {
    raw = await openRouterBrain(GPT(), { key: 'k' }).decide(input, context());
  });
  const answer = asAnswer(raw);
  assert.deepEqual(answer.noul, { hold: true });
  assert.deepEqual(answer.score, { risk: 0.3 });
  const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
  assert.equal(checked.status, 'ok');
  if (checked.status === 'ok') assert.equal(checked.hold, true);
});

test('retries once on HTTP 429 with backoff and reports the retry', async () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  let raw: unknown;
  const calls = await withFetch((_call, index) => (index === 0 ? json({ error: { message: 'rate limited' } }, 429) : chatReply(JSON.stringify({ candidate: id }), { cost: 0.001 })), async () => {
    raw = await openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000));
  });
  assert.equal(calls.length, 2);
  const answer = asAnswer(raw);
  assert.equal(answer.meta?.retries, 1);
  assert.equal(answer.costUsd, 0.001);
  assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'ok');
});

test('an HTTP 200 carrying an OpenRouter error envelope is a provider failure, retried when its code allows', async () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  let raw: unknown;
  const calls = await withFetch((_call, index) => (index === 0 ? json({ error: { message: 'Provider returned error', code: 502 } }, 200) : chatReply(JSON.stringify({ candidate: id }), { cost: 0.001 })), async () => {
    raw = await openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000));
  });
  assert.equal(calls.length, 2, 'the envelope is retried like a 502');
  assert.equal(asAnswer(raw).meta?.retries, 1);
  assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'ok');
  // A non-retryable envelope surfaces as a provider error, never as the brain's invalid answer.
  const fatal = await withFetch(() => json({ error: { message: 'bad request', code: 400 } }, 200), async () => {
    await assert.rejects(
      () => Promise.resolve(openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000))),
      (error: unknown) => error instanceof ProviderError && error.status === 400,
    );
  });
  assert.equal(fatal.length, 1);
});

test('retries once on a network failure and on 5xx, then throws', async () => {
  const input = fixture('left');
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  let raw: unknown;
  const network = await withFetch((_call, index) => {
    if (index === 0) throw new TypeError('fetch failed');
    return chatReply(JSON.stringify({ candidate: id }));
  }, async () => {
    raw = await openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(null));
  });
  assert.equal(network.length, 2);
  assert.equal(asAnswer(raw).meta?.retries, 1);

  const failing = await withFetch(() => json({ error: 'down' }, 503), async () => {
    await assert.rejects(
      () => Promise.resolve(openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000))),
      (error: unknown) => error instanceof ProviderError && error.status === 503,
    );
  });
  assert.equal(failing.length, 2, 'second failure throws');
});

test('no retry when the remaining budget is too small or the error is not retryable', async () => {
  const input = fixture('left');
  const small = await withFetch(() => json({}, 429), async () => {
    await assert.rejects(
      () => Promise.resolve(openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(1000))),
      (error: unknown) => error instanceof ProviderError && error.status === 429,
    );
  });
  assert.equal(small.length, 1);
  const badRequest = await withFetch(() => json({}, 400), async () => {
    await assert.rejects(
      () => Promise.resolve(openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000))),
      (error: unknown) => error instanceof ProviderError && error.status === 400,
    );
  });
  assert.equal(badRequest.length, 1);
});

test('the abort signal is passed through to fetch for both transports', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  const evidence = renderEvidence(input);
  const [id] = [...evidence.ids.keys()];
  const controller = new AbortController();
  const calls = await withFetch(call => (call.url.endsWith('/systemone')
    ? json({ answers: { placement: { probabilities: { [id]: 1 } } }, usage: { cost: 0.00001 } })
    : chatReply(JSON.stringify({ candidate: id }))), async () => {
    await openRouterBrain(GPT(), { key: 'k' }).decide(input, context(20_000, controller.signal));
    await jevBrain({ key: 'k' }).decide(input, context(null, controller.signal));
  });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.signal, controller.signal);

  // An aborted call is never retried.
  const aborted = await withFetch(call => {
    controller.abort();
    const error = new Error('aborted');
    error.name = 'AbortError';
    void call;
    throw error;
  }, async () => {
    await assert.rejects(() => Promise.resolve(openRouterBrain(GPT(), { key: 'k', retryBackoffMs: 5 }).decide(input, context(20_000, controller.signal))));
  });
  assert.equal(aborted.length, 1);
});

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------

test('Jev: systemone body carries the shared evidence, criteria per id, a grounded hold and the risk question', async () => {
  jevMemory.riskQuestionRejected = false;
  const input = inputFor(createGame('test'), 'IQ');
  const evidence = renderEvidence(input);
  const ids = [...evidence.ids.keys()];
  const calls = await withFetch(() => json({ answers: { placement: { probabilities: { [ids[2]]: 1 } } }, usage: { cost: 0.00002 } }), async () => {
    const raw = await jevBrain({ key: 'test-key' }).decide(input, context());
    const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
    assert.equal(checked.status, 'ok');
    if (checked.status === 'ok') assert.deepEqual(checked.placement, evidence.ids.get(ids[2])!.placement);
    assert.ok(!JSON.stringify(raw).includes('test-key'));
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://openrouter.ai/api/v1/systemone');
  assert.equal(call.body.model, 'typesafe/jev-1.13');
  assert.equal(call.body.state, `${evidence.system}\n\n${evidence.user}`);
  const questions = call.body.questions as Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
  assert.equal(questions.placement.type, 'choice');
  assert.ok(questions.placement.instructions.includes('Never pick a candidate with topOut=yes'));
  assert.deepEqual(Object.keys(questions.placement.criteria!), ids);
  for (const id of ids) assert.equal(questions.placement.criteria![id], candidateLine(evidence.ids.get(id)!));
  assert.equal(questions.hold.type, 'noul');
  assert.equal(questions.hold.instructions, `Hold the active piece ${input.active.type} instead of placing it. The hold slot holds nothing; holding means the piece placed now is ${input.next[0]}. Answer yes only if that is clearly better.`);
  assert.equal(questions.risk.type, 'score');
  assert.ok(questions.risk.instructions.includes('tops out within the next ten pieces'));
  const ladder = (questions.risk as unknown as { criteria: unknown }).criteria;
  assert.ok(Array.isArray(ladder) && ladder.length === 5, 'a score question rates an ordered ladder of five bands');
});

test('Jev: no hold question when hold is unavailable, and the held piece is named when it is', async () => {
  const noHold = inputFor(applyHold(createGame('test')), 'IQ');
  assert.equal(noHold.canHold, false);
  const idsA = [...renderEvidence(noHold).ids.keys()];
  const first = await withFetch(() => json({ answers: { placement: { probabilities: { [idsA[0]]: 1 } }, hold: { noul: 0.9 } } }), async () => {
    const raw = await jevBrain({ key: 'k' }).decide(noHold, context());
    assert.equal(asAnswer(raw).noul, undefined, 'a hold answer is ignored when hold is unavailable');
    assert.equal(validateAnswer(raw, noHold.stateHash, noHold.legal, noHold.canHold).status, 'ok');
  });
  assert.equal((first[0].body.questions as Record<string, unknown>).hold, undefined);

  // Hold something, place the next piece, and the following question can hold again with a filled slot.
  const filled = inputFor(createGame('test'), 'IQ');
  filled.hold = 'T';
  const idsB = [...renderEvidence(filled).ids.keys()];
  const second = await withFetch(() => json({ answers: { placement: { probabilities: { [idsB[0]]: 1 } } } }), async () => {
    await jevBrain({ key: 'k' }).decide(filled, context());
  });
  const hold = (second[0].body.questions as Record<string, { instructions: string }>).hold;
  assert.equal(hold.instructions, `Hold the active piece ${filled.active.type} instead of placing it. The hold slot holds T; holding means the piece placed now is T. Answer yes only if that is clearly better.`);
});

test('Jev: probabilities are normalised over every listed id, mass and hold and risk are forwarded', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  const evidence = renderEvidence(input);
  const ids = [...evidence.ids.keys()];
  let raw: unknown;
  await withFetch(() => json({
    answers: {
      placement: { probabilities: { [ids[0]]: 0.55, [ids[1]]: 0.3, [ids[2]]: 0.14 } },
      hold: { noul: 0.2 },
      // Band probabilities: 0.5 × 0.05 + 0.5 × 0.95 = 0.5 expected risk. The `score` of 0.4 would
      // give 0.12 through the rung-index fallback, so the assertion tells the two paths apart.
      risk: { type: 'score', score: 0.4, probabilities: { '0': 0.5, '4': 0.5 } },
    },
    usage: { cost: 0.000013 },
  }), async () => {
    raw = await jevBrain({ key: 'k' }).decide(input, context());
  });
  const answer = asAnswer(raw);
  assert.equal(answer.choice.length, 3);
  const mass = answer.choice.reduce((sum, c) => sum + c.p, 0);
  assert.ok(Math.abs(mass - 1) < 1e-12);
  assert.ok(Math.abs((answer.providerProbabilityMass ?? 0) - 0.99) < 1e-12);
  assert.deepEqual(answer.choice.map(c => ({ x: c.x, rotation: c.rotation })), ids.slice(0, 3).map(id => evidence.ids.get(id)!.placement));
  assert.deepEqual(answer.noul, { hold: 0.2 });
  assert.ok(answer.score && Math.abs(answer.score.risk - 0.5) < 1e-12, `risk ${answer.score?.risk} should be the expected band midpoint 0.5`);
  assert.equal(answer.costUsd, 0.000013);
  assert.deepEqual(answer.meta, { retries: 0 });
  const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
  assert.equal(checked.status, 'ok');
  if (checked.status === 'ok') {
    assert.equal(checked.hold, false);
    assert.deepEqual(checked.placement, evidence.ids.get(ids[0])!.placement);
  }
});

test('Jev: boolean hold is forwarded as a boolean', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  const [id] = [...renderEvidence(input).ids.keys()];
  let raw: unknown;
  await withFetch(() => json({ answers: { placement: { probabilities: { [id]: 1 } }, hold: { noul: true } } }), async () => {
    raw = await jevBrain({ key: 'k' }).decide(input, context());
  });
  assert.deepEqual(asAnswer(raw).noul, { hold: true });
  const checked = validateAnswer(raw, input.stateHash, input.legal, input.canHold);
  assert.equal(checked.status, 'ok');
  if (checked.status === 'ok') assert.equal(checked.hold, true);
});

test('Jev: unknown ids or an out-of-bound mass are unusable but keep the cost', async () => {
  const input = inputFor(createGame('test'), 'IQ');
  const [id] = [...renderEvidence(input).ids.keys()];
  const replies = [
    { answers: { placement: { probabilities: { p0: 1 } } }, usage: { cost: 0.00001 } },
    { answers: { placement: { probabilities: { [id]: 0.7 } } }, usage: { cost: 0.00002 } },
    { answers: {}, usage: { cost: 0.00003 } },
  ];
  let index = 0;
  await withFetch(() => json(replies[index++]), async () => {
    for (const expectedCost of [0.00001, 0.00002, 0.00003]) {
      const raw = await jevBrain({ key: 'k' }).decide(input, context());
      const answer = asAnswer(raw);
      assert.deepEqual(answer.choice, []);
      assert.equal(answer.costUsd, expectedCost);
      assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'invalid');
    }
  });
});

test('Jev: the risk question is dropped for the process after an HTTP 400 and the warning is logged once', async () => {
  jevMemory.riskQuestionRejected = false;
  const input = inputFor(createGame('test'), 'IQ');
  const [id] = [...renderEvidence(input).ids.keys()];
  const warnings: string[] = [];
  const ok = () => json({ answers: { placement: { probabilities: { [id]: 1 } } }, usage: { cost: 0.00001 } });
  try {
    const calls = await withFetch(call => ((call.body.questions as Record<string, unknown>).risk ? json({ error: 'unknown question type' }, 400) : ok()), async () => {
      const brain = jevBrain({ key: 'k', warn: message => warnings.push(message) });
      for (let i = 0; i < 2; i++) {
        const raw = await brain.decide(input, context());
        assert.equal(validateAnswer(raw, input.stateHash, input.legal, input.canHold).status, 'ok');
      }
    });
    assert.equal(calls.length, 3, 'one rejected call, one retry without risk, one later call without risk');
    assert.ok((calls[0].body.questions as Record<string, unknown>).risk);
    assert.equal((calls[1].body.questions as Record<string, unknown>).risk, undefined);
    assert.equal((calls[2].body.questions as Record<string, unknown>).risk, undefined);
    assert.equal(warnings.length, 1);
    assert.equal(jevMemory.riskQuestionRejected, true);

    const disabled = await withFetch(ok, async () => {
      await jevBrain({ key: 'k', riskQuestion: false }).decide(input, context());
    });
    assert.equal((disabled[0].body.questions as Record<string, unknown>).risk, undefined);
  } finally {
    jevMemory.riskQuestionRejected = false;
  }
});

test('Jev transport rounding preserves argmax without accepting arbitrary scores', () => {
  const rounded = normaliseChoiceProbabilities({ p0: 0.55, p1: 0.3, p2: 0.14 });
  assert.ok(rounded);
  assert.ok(Math.abs(Object.values(rounded.probabilities).reduce((s, p) => s + p, 0) - 1) < 1e-12);
  assert.ok(rounded.probabilities.p0 > rounded.probabilities.p1);
  assert.ok(Math.abs(rounded.mass - 0.99) < 1e-12);
  const invalidCases: Record<string, number>[] = [{ p0: 0 }, { p0: NaN }, { p0: 1.1 }, { p0: 0.6, p1: 0.6 }, { p0: 0.7, p1: 0.1 }];
  for (const invalid of invalidCases) assert.equal(normaliseChoiceProbabilities(invalid), null);
});

test('hostedBrain picks the transport by registry kind and exposes provenance fields', () => {
  const jev = hostedBrain(model('jev'), { key: 'k' });
  assert.deepEqual([jev.slug, jev.kind, jev.provider, jev.model, jev.via, jev.adapterVersion], ['jev', 'classifier', 'TypeSafe', 'typesafe/jev-1.13', 'OpenRouter', ADAPTER_VERSION]);
  const gpt = hostedBrain(GPT(), { key: 'k' });
  assert.deepEqual([gpt.slug, gpt.name, gpt.kind, gpt.provider, gpt.model, gpt.via], ['gpt-4o-mini', 'GPT-4o mini', 'llm', 'OpenAI', 'openai/gpt-4o-mini', 'OpenRouter']);
  assert.throws(() => openRouterBrain(model('jev'), { key: 'k' }));
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.throws(() => openRouterBrain(GPT()), /OPENROUTER_API_KEY/);
  } finally {
    if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
  }
});
