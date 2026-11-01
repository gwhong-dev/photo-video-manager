// 파일 위치: lib/manual-journal.js
// 역할: "직접 넣은 값"의 기록 파일(userData/manual-edits.jsonl) 읽기와 쓰기, 그리고 복구.
//   한 줄에 작업 하나를 JSON으로 적고, 지우지 않고 뒤에 더하기만 해요.
//   library.db 가 깨져서 새로 만들어져도, 이 파일을 다시 읽어서 직접 넣은 값을 되살려요.
//
// 줄 모양
//   {"type":"apply","batchId","at","root","kind","items":[{"path","before","after"}]}  값 넣기
//   {"type":"undo","batchId","at"}                                                    되돌리기
//   {"type":"void","of":"apply"|"undo","batchId"}  바로 앞의 같은 묶음 줄이 DB에 저장되지 못했다는 표시
//
// Electron 없이 일반 Node에서도 돌아가요 (사진 파일은 건드리지 않고, 기록 파일만 읽고 써요).

const fs = require('fs');
const path = require('path');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

// 줄 하나가 읽을 수 있는 모양인지 검사해요 (틀리면 건너뛰기 위해)
function validLine(l) {
  if (!isObj(l) || !isStr(l.batchId)) return false;
  if (l.type === 'undo') return isStr(l.at);
  if (l.type === 'void') return l.of === 'apply' || l.of === 'undo';
  if (l.type === 'apply') {
    return isStr(l.at) && isStr(l.root) && isStr(l.kind) && Array.isArray(l.items)
      && l.items.every((it) => isObj(it) && isStr(it.path) && isObj(it.after));
  }
  return false;
}

// 기록 파일 하나를 다루는 도구를 만들어요
function createJournal(filePath) {
  return {
    // 한 줄을 뒤에 더해요 (동기). 실패하면 오류를 그대로 던져요.
    //   앞 줄이 중간에 잘려 있으면(끝이 줄바꿈이 아님) 줄을 바꾼 뒤에 써서, 새 줄이 깨진 줄에 붙지 않게 해요
    append(line) {
      let prefix = '';
      let fd = null;
      try {
        fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        }
      } catch (e) {
        // 파일이 아직 없으면 그냥 새로 만들어요. 다른 이유(권한 등)는 아래 쓰기에서 오류가 나요
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, prefix + JSON.stringify(line) + '\n', 'utf8');
    },

    // 파일을 끝까지 읽어요. 읽을 수 없는 줄(끝이 잘렸거나 깨진 줄, 모르는 모양)은 건너뛰고 skipped에 세요.
    //   파일이 없으면 빈 결과예요
    read() {
      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { lines: [], skipped: 0 };
        throw e;
      }
      const lines = [];
      let skipped = 0;
      for (const raw of text.split('\n')) {
        const s = raw.replace(/\r$/, '');
        if (!s.trim()) continue; // 빈 줄은 세지 않아요
        let obj;
        try {
          obj = JSON.parse(s);
        } catch {
          skipped++;
          continue;
        }
        if (validLine(obj)) lines.push(obj);
        else skipped++;
      }
      return { lines, skipped };
    },
  };
}

// void 줄을 정리해요: void는 그 앞에 있는 같은 종류(of)와 같은 batchId 줄 중 가장 가까운 것과 함께 지워요
function dropVoided(lines) {
  const kept = [];
  for (const l of lines) {
    if (l.type !== 'void') {
      kept.push(l);
      continue;
    }
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].type === l.of && kept[i].batchId === l.batchId) {
        kept.splice(i, 1);
        break;
      }
    }
  }
  return kept;
}

// 기록 파일을 DB에 맞춰요. 프로그램을 켤 때 한 번 불러요.
//   apply는 DB에 그 묶음이 없을 때만, undo는 DB에서 "적용됨"일 때만 적용해요 (이미 있으면 건너뜀 → 여러 번 불러도 같음)
//   어떤 묶음을 DB에 적용하다 오류가 나도 skipped로 세고 다음으로 넘어가요. 시작을 막지 않아요.
//   → { applied: 넣은 묶음 수, undone: 되돌린 묶음 수, skipped: 읽지 못했거나 적용하지 못한 줄 수 }
function recover(db, journal) {
  let read;
  try {
    read = journal.read();
  } catch {
    return { applied: 0, undone: 0, skipped: 1 }; // 파일을 열 수 없음: 시작은 계속
  }
  const result = { applied: 0, undone: 0, skipped: read.skipped };
  for (const l of dropVoided(read.lines)) {
    try {
      if (l.type === 'apply') {
        if (db.batchStatus(l.batchId) !== 'none') continue;
        db.applyManualBatch({
          id: l.batchId, root: l.root, kind: l.kind, createdAt: l.at,
          items: l.items.map((it) => ({ path: it.path, before: it.before ?? null, after: it.after })),
        });
        result.applied++;
      } else if (l.type === 'undo') {
        if (db.batchStatus(l.batchId) !== 'applied') continue;
        db.undoBatch(l.batchId, l.at);
        result.undone++;
      }
    } catch {
      result.skipped++;
    }
  }
  return result;
}

module.exports = { createJournal, recover };
