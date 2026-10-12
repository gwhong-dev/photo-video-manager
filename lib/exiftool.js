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
    const failed = /weren't updated due to errors|0 image files updated/.test(stdout);
    if (failed) {
      const msg = (stderr.trim().split(/\r?\n/).pop() || '알 수 없는 오류').trim();
      throw new Error('exiftool: ' + msg);
    }
    return stdout;
  }

  // 끄기 (프로그램 종료할 때)
  close() {
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

module.exports = { ExifTool };
