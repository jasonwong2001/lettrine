// A mounted code editor owns the body, while delimiters stay in the model.
// Only a line matching the opener's character and minimum length can close it.
export function fenceInput(block, value, forceClose = false) {
  const opening = block.src.split("\n")[0];
  const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(opening)?.[1] || "```";
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line) => {
    const match = /^\s{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    return match && match[1][0] === fence[0] && match[1].length >= fence.length;
  });
  if (end >= 0) return { source: [opening, ...lines.slice(0, end + 1)].join("\n"), tail: lines.slice(end + 1).join("\n"), closedByInput: true };
  const closing = block.closed ? block.src.split("\n").at(-1) : fence;
  return { source: opening + "\n" + lines.join("\n") + (block.closed || forceClose ? "\n" + closing : ""), tail: "", closedByInput: false };
}
