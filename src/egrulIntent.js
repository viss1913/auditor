const EGRUL_INTENT_RE =
  /егрюл|егрип|выписк\w*\s+егр|провер\w*\s+контрагент|недостоверн|достоверн\w*\s+сведен/i;

export function isEgrulIntent(message) {
  return EGRUL_INTENT_RE.test(String(message || ''));
}
