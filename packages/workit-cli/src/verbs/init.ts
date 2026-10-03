// `workit init`: the only verbs that load ink/react do it here, lazily.
export async function run(): Promise<number> {
  const { runInit } = await import("../index");
  await runInit();
  return 0;
}
