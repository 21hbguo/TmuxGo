const ANSI_ESCAPE_REGEX=/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const CONTROL_CHAR_REGEX=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
export function stripTerminalControlSequences(value:string) {
  return value.replace(ANSI_ESCAPE_REGEX,'').replace(CONTROL_CHAR_REGEX,'')
}
export function hasVisibleTerminalContent(value:string) {
  return stripTerminalControlSequences(value).replace(/\s/g,'').length>0
}
