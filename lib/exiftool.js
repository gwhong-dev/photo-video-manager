// 파일 위치: lib/exiftool.js
// 역할: exiftool을 "계속 켜 둔 상태"로 사용하기 (stay_open 모드)
//
// 왜?  exiftool은 켜는 데만 0.3~1초 걸려요.
//      파일 1만 개를 처리할 때 매번 켜면 → 몇 시간 낭비!
//      그래서 한 번 켜 두고, 명령만 계속 보내요.
//
// 한글 경로(G:\_홍경우사진백업정리 등)도 되도록 utf8 옵션을 항상 붙여요.

const { spawn } = require('child_process');

class ExifTool {
  constructor(exePath) {
    this.exePath = exePath;
    this.proc = null;    // 실행 중인 exiftool
    this.queue = [];     // 기다리는 명령들
    this.current = null; // 지금 처리 중인 명령
    this.out = '';       // 표준 출력 모으는 곳
    this.err = '';       // 에러 출력 모으는 곳
    this.counter = 0;    // 명령 번호
    this.closed = false; // close() 한 뒤인지 (닫은 뒤에는 다시 켜지 않고 거절해요)
  }

  // exiftool 켜기
  start() {
    if (this.proc) return;
    this.proc = spawn(
      this.exePath,
      ['-stay_open', 'True', '-@', '-', '-common_args', '-charset', 'filename=utf8'],
      { windowsHide: true }
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => { this.out += d; this._check(); });
    this.proc.stderr.on('data', (d) => { this.err += d; this._check(); });
    this.proc.on('error', (e) => this._failAll(new Error('exiftool 실행 실패: ' + e.message)));
    this.proc.on('exit', () => {
      this.proc = null;
      this._failAll(new Error('exiftool이 중간에 종료됐어요'));
    });
  }

  // 명령 보내기 → 결과 { stdout, stderr }
  run(args) {
    // 닫힌 뒤에 부르면 exiftool을 다시 켜지 않고 거절해요 (도구를 새로 찾을 때 닫힌 옛 객체가 되살아나 exiftool.exe가 남는 걸 막아요)
    if (this.closed) return Promise.reject(new Error('exiftool이 이미 닫혔어요'));
    this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ args, resolve, reject });
      this._next();
    });
  }

  _next() {
    if (this.current || this.queue.length === 0 || !this.proc) return;
    const c = this.queue.shift();
    c.id = ++this.counter;
    this.current = c;
    // 끝 표시: 출력 끝에 {ready번호}, 에러 끝에 {done번호}가 찍혀요
    const lines = [...c.args, '-echo4', `{done${c.id}}`, `-execute${c.id}`];
    this.proc.stdin.write(lines.join('\n') + '\n');
  }

  _check() {
    const c = this.current;
    if (!c) return;
    const readyMark = `{ready${c.id}}`;
    const doneMark = `{done${c.id}}`;
    const ri = this.out.indexOf(readyMark);
    const di = this.err.indexOf(doneMark);
    if (ri === -1 || di === -1) return; // 아직 덜 끝남

    const stdout = this.out.slice(0, ri);
    const stderr = this.err.slice(0, di);
    this.out = this.out.slice(ri + readyMark.length).replace(/^\r?\n/, '');
    this.err = this.err.slice(di + doneMark.length).replace(/^\r?\n/, '');
    this.current = null;
    c.resolve({ stdout, stderr });
    this._next();
  }

  _failAll(err) {
    if (this.current) this.current.reject(err);
    this.queue.forEach((c) => c.reject(err));
    this.current = null;
    this.queue = [];
  }

  // ---------- 편하게 쓰는 함수들 ----------

  // 여러 파일의 정보를 한 번에 읽기 → [{ SourceFile, DateTimeOriginal, ... }]
  async read(files, tags) {
    if (files.length === 0) return [];
    const args = ['-j', '-api', 'QuickTimeUTC', ...tags.map((t) => '-' + t), ...files];
    const { stdout } = await this.run(args);
    const text = stdout.trim();
    if (!text) return [];
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('exiftool 결과를 읽지 못했어요');
    }
  }

  // 정보 쓰기 (실패하면 에러)
  async write(args) {
    const { stdout, stderr } = await this.run(args);
    // "unchanged" = 이미 같은 값이라 바꿀 게 없었음 → 실패가 아니에요
    const failed =
      /weren't updated due to errors/.test(stdout) ||
      (/\b0 image files updated/.test(stdout) && !/image files? unchanged/.test(stdout));
    if (failed) {
      const msg = (stderr.trim().split(/\r?\n/).pop() || '알 수 없는 오류').trim();
      throw new Error('exiftool: ' + msg);
    }
    return stdout;
  }

  // 끄기 (프로그램 종료할 때)
  close() {
    this.closed = true;
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try {
      p.stdin.write('-stay_open\nFalse\n'); // "이제 그만" 신호
      p.stdin.end();
    } catch (e) {
      // 이미 꺼졌으면 무시
    }
    // 1.5초 안에 안 꺼지면 강제로 끄기 (작업 관리자에 남지 않게)
    const t = setTimeout(() => {
      try { p.kill(); } catch (e) { /* 무시 */ }
    }, 1500);
    t.unref();
  }
}

// 여러 개를 켜 두고 나눠 쓰기 (가져오기 실행 · 미리보기에서 파일 여러 개를 동시에 처리할 때)
//   exiftool 하나는 명령을 한 번에 하나씩만 처리해요 → 동시에 처리하는 파일이 많으면 여기서 줄을 서요
//   그래서 몇 개를 켜 두고, 기다리는 명령이 가장 적은 것에 보내요. read · write 는 ExifTool 과 같아요
//   size: 동시에 보낼 수 있는 명령 수 (planner 가 한 번에 읽을 묶음 수를 정할 때 써요)
class ExifToolPool {
  constructor(exePath, size) {
    this.exePath = exePath;
    this.size = Math.max(1, Number(size) || 1);
    this.items = Array.from({ length: this.size }, () => new ExifTool(exePath));
    this.closed = false;
  }

  run(args) {
    if (this.closed) return Promise.reject(new Error('exiftool이 이미 닫혔어요'));
    const load = (e) => e.queue.length + (e.current ? 1 : 0);
    const pick = this.items.reduce((a, b) => (load(b) < load(a) ? b : a));
    return pick.run(args);
  }

  close() {
    this.closed = true;
    for (const e of this.items) e.close();
  }
}
ExifToolPool.prototype.read = ExifTool.prototype.read;
ExifToolPool.prototype.write = ExifTool.prototype.write;

module.exports = { ExifTool, ExifToolPool };
