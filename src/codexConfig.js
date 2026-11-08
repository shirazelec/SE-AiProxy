// Sets a top-level `key = value` in TOML text. Only the part before the first [table] header is
// touched, so keys with the same name inside sections (e.g. [profiles.x]) are left alone.
export function setTopLevelTomlKey(content, key, value) {
  const headerMatch = /^\s*\[/m.exec(content);
  const splitAt = headerMatch ? headerMatch.index : content.length;
  let head = content.slice(0, splitAt).trimEnd();
  const rest = content.slice(splitAt).trimStart();
  const line = `${key} = ${value}`;
  const keyRe = new RegExp(`^${key}\\s*=.*$`, 'm');
  head = keyRe.test(head) ? head.replace(keyRe, line) : (head ? `${head}\n${line}` : line);
  return `${head}\n${rest ? `\n${rest}` : ''}`;
}
