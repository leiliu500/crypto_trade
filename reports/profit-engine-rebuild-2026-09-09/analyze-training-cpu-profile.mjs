import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = new URL('cpu-profile/', import.meta.url);
const bytes = readFileSync(new URL('training-prefix.cpuprofile', dir));
const profile = JSON.parse(bytes), summary = JSON.parse(readFileSync(new URL('prefix-summary.json', dir)));
const nodes = new Map(profile.nodes.map(n => [n.id, n])), parents = new Map();
for (const node of nodes.values()) for (const child of node.children ?? []) parents.set(child, node.id);
const groups = new Map(), files = new Map();
const display = n => ({ function: n.callFrame.functionName || '(anonymous)', file: n.callFrame.url || '(V8/native)',
  line: n.callFrame.lineNumber + 1, column: n.callFrame.columnNumber + 1 });
const groupKey = n => `${n.callFrame.url}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}:${n.callFrame.functionName}`;
for (const node of nodes.values()) {
  const key = groupKey(node);
  if (!groups.has(key)) groups.set(key, { ...display(node), selfSamples: 0, inclusiveSamples: 0, selfWallMicroseconds: 0, inclusiveWallMicroseconds: 0 });
  if (!files.has(node.callFrame.url)) files.set(node.callFrame.url, { file: node.callFrame.url || '(V8/native)', selfSamples: 0,
    inclusiveSamples: 0, selfWallMicroseconds: 0, inclusiveWallMicroseconds: 0 });
}
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i], duration = profile.timeDeltas?.[i] ?? 0, node = nodes.get(id);
  const self = groups.get(groupKey(node)), file = files.get(node.callFrame.url);
  self.selfSamples++; self.selfWallMicroseconds += duration;
  file.selfSamples++; file.selfWallMicroseconds += duration;
  let cursor = id; const seen = new Set(), seenFiles = new Set();
  while (cursor !== undefined) {
    const ancestor = nodes.get(cursor), key = groupKey(ancestor), row = groups.get(key), file = files.get(ancestor.callFrame.url);
    if (!seen.has(key)) { row.inclusiveSamples++; row.inclusiveWallMicroseconds += duration; seen.add(key); }
    if (!seenFiles.has(ancestor.callFrame.url)) { file.inclusiveSamples++; file.inclusiveWallMicroseconds += duration; seenFiles.add(ancestor.callFrame.url); }
    cursor = parents.get(cursor);
  }
}
const total = profile.samples.length;
const present = row => ({ ...row, selfSamplePercent: row.selfSamples / total * 100, inclusiveSamplePercent: row.inclusiveSamples / total * 100 });
const source = [...groups.values()].filter(r => r.file.includes('/work/src/'));
const output = { generatedAtUtc: new Date().toISOString(), summary,
  profileSha256: createHash('sha256').update(bytes).digest('hex'), samples: total,
  profileWallMs: (profile.endTime - profile.startTime) / 1000,
  interpretation: 'Percentages use V8 sample counts. Inclusive time overlaps between ancestor functions; do not add inclusive percentages. timeDeltas are wall-time attribution and may include CPU-quota scheduling delays. CPU time is measured separately in prefix-summary.json.',
  topSelfFunctions: [...groups.values()].sort((a,b) => b.selfSamples - a.selfSamples).slice(0, 35).map(present),
  topInclusiveSourceFunctions: source.sort((a,b) => b.inclusiveSamples - a.inclusiveSamples).slice(0, 35).map(present),
  sourceFilesBySelfSamples: [...files.values()].filter(r => r.file.includes('/work/src/')).sort((a,b) => b.selfSamples - a.selfSamples).map(present) };
writeFileSync(new URL('analysis.json', dir), JSON.stringify(output, null, 2) + '\n');
const brief = r => ({ function: r.function, file: r.file.replace('file:///work/', ''), line: r.line,
  selfPercent: Number(r.selfSamplePercent.toFixed(2)), inclusivePercent: Number(r.inclusiveSamplePercent.toFixed(2)) });
console.log(JSON.stringify({ samples: total, profileWallMs: output.profileWallMs, cpuMs: summary.cpuMs, inputEvents: summary.inputEvents,
  topSelf: output.topSelfFunctions.slice(0, 15).map(brief), topInclusiveSource: output.topInclusiveSourceFunctions.slice(0, 12).map(brief) }, null, 2));
