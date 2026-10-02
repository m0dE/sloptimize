// A drive script, as a game would write one: name the phases, move the
// camera (here: the mouse), press a key, read the page.
export default async function drive({ phase, at, eval: run, move, key, wait, log }) {
  await phase('warmup');
  await at(1, () => phase('orbit'));
  for (let i = 0; i < 10; i++) { await move(10 + i * 4, 20); await wait(50); }
  await key('w', { holdMs: 100 });
  log('cars stepped:', await run('typeof cars === "number" ? cars : -1'));
  await at(2.5);
}
