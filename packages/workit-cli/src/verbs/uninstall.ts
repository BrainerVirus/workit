// `workit uninstall`: interactive host picker, ink/react loaded lazily.
export async function run(): Promise<number> {
  const { runUninstall } = await import("../index");
  await runUninstall();
  return 0;
}
