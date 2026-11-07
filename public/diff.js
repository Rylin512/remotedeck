const MAX_DIFF_LINES = 500;
const MAX_DIFF_CELLS = 200_000;
const MAX_DISPLAY_LINES = 180;

function splitLines(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
}

function simpleDiff(oldLines, newLines) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const out = [];
  for (let i = 0; i < prefix; i += 1) out.push({ type: 'ctx', text: oldLines[i] });
  for (let i = prefix; i < oldLines.length - suffix; i += 1) out.push({ type: 'del', text: oldLines[i] });
  for (let i = prefix; i < newLines.length - suffix; i += 1) out.push({ type: 'add', text: newLines[i] });
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) out.push({ type: 'ctx', text: oldLines[i] });
  return out;
}

function lcsDiff(oldLines, newLines) {
  if (!oldLines.length) return newLines.map((text) => ({ type: 'add', text }));
  if (!newLines.length) return oldLines.map((text) => ({ type: 'del', text }));
  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) return simpleDiff(oldLines, newLines);

  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: 'ctx', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: oldLines[i] });
      i += 1;
    } else {
      out.push({ type: 'add', text: newLines[j] });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    out.push({ type: 'del', text: oldLines[i] });
    i += 1;
  }
  while (j < newLines.length) {
    out.push({ type: 'add', text: newLines[j] });
    j += 1;
  }
  return out;
}

function trimTrailingEmpty(lines) {
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffText(oldText, newText) {
  let oldLines = trimTrailingEmpty(splitLines(oldText));
  let newLines = trimTrailingEmpty(splitLines(newText));
  let truncated = false;
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    oldLines = oldLines.slice(0, MAX_DIFF_LINES);
    newLines = newLines.slice(0, MAX_DIFF_LINES);
    truncated = true;
  }
  return { lines: lcsDiff(oldLines, newLines), truncated };
}

export function buildEditDiff(name, input = {}) {
  const edits = [];
  if (name === 'Edit') {
    edits.push({ oldText: input.old_string || '', newText: input.new_string || '' });
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits.slice(0, 20)) {
      edits.push({ oldText: edit?.old_string || '', newText: edit?.new_string || '' });
    }
  }
  if (!edits.length) return null;

  const lines = [];
  let adds = 0;
  let dels = 0;
  let truncated = false;
  edits.forEach((edit, index) => {
    if (index > 0) lines.push({ type: 'sep', text: `第 ${index + 1} 处修改` });
    const diff = diffText(edit.oldText, edit.newText);
    truncated = truncated || diff.truncated;
    for (const line of diff.lines) {
      if (line.type === 'add') adds += 1;
      if (line.type === 'del') dels += 1;
      lines.push(line);
    }
  });

  const shown = lines.slice(0, MAX_DISPLAY_LINES);
  return {
    lines: shown,
    adds,
    dels,
    truncated: truncated || lines.length > shown.length,
    totalLines: lines.length,
  };
}
