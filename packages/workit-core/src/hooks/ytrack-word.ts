/** `ytrack` where a command name can end: not glued to more of a name (`ytrack-notes`, `ytrack/x`, `ytrack.md`). */
export const YTRACK_WORD = /ytrack(?![\w/-]|\.(?!exe|cmd))/i;
/** Whether `text` may run ytrack: the one test the gate and both launchers share. */
export const namesYtrack = (text: string): boolean => {
  const bare = text.replace(/['"\\]/g, "");
  return YTRACK_WORD.test(bare) || YTRACK_WORD.test(bare.replace(/`/g, ""));
};
