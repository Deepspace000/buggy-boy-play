// SID (MOS 6581-style) emulation, fed with the game's register writes: sid-worklet.js runs it in an
// AudioWorklet, audio.js on the main thread where there is none (plain-http pages, some embedded views).
// Voices: 24-bit phase accumulators with saw/triangle/pulse/noise (+ANDed combinations), ring mod,
// hard sync, test bit; ADSR with the chip's rate counter periods and exponential decay steps;
// a two-pole state-variable filter (LP/BP/HP) with resonance; 4-bit master volume.
// Writes arrive per C64 frame with a position inside the frame, and are applied on the audio
// clock with a small latency so timing inside the frame is preserved.

const PAL_CLOCK = 985248;
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
const ATTACK = 0, DECAY_SUSTAIN = 1, RELEASE = 2;

function expPeriod(env) {
  if (env >= 0x5d) return 1;
  if (env >= 0x36) return 2;
  if (env >= 0x1a) return 4;
  if (env >= 0x0e) return 8;
  if (env >= 0x06) return 16;
  return 30;
}

class Voice {
  constructor() {
    this.acc = 0; this.freq = 0; this.pw = 0; this.ctrl = 0;
    this.ad = 0; this.sr = 0;
    this.env = 0; this.state = RELEASE; this.rateCounter = 0; this.ratePeriod = RATE_PERIOD[0]; this.expCounter = 0;
    this.lfsr = 0x7ffff8; this.holdZero = true;
    this.prevMsb = 0;
  }

  setCtrl(v) {
    const gateOn = (v & 1) && !(this.ctrl & 1);
    const gateOff = !(v & 1) && (this.ctrl & 1);
    this.ctrl = v;
    if (gateOn) { this.state = ATTACK; this.ratePeriod = RATE_PERIOD[this.ad >> 4]; this.holdZero = false; }
    if (gateOff) { this.state = RELEASE; this.ratePeriod = RATE_PERIOD[this.sr & 15]; }
    if (v & 8) { this.acc = 0; }                 // test bit
  }

  setAD(v) { this.ad = v; if (this.state === ATTACK) this.ratePeriod = RATE_PERIOD[v >> 4]; else if (this.state === DECAY_SUSTAIN) this.ratePeriod = RATE_PERIOD[v & 15]; }
  setSR(v) { this.sr = v; if (this.state === RELEASE) this.ratePeriod = RATE_PERIOD[v & 15]; }

  // advance the envelope by n cycles
  clockEnv(n) {
    while (n > 0) {
      const toStep = this.ratePeriod - this.rateCounter;
      if (toStep > n) { this.rateCounter += n; return; }
      n -= toStep;
      this.rateCounter = 0;
      if (this.state === ATTACK || ++this.expCounter >= expPeriod(this.env)) {
        this.expCounter = 0;
        if (this.holdZero) continue;
        if (this.state === ATTACK) {
          this.env = (this.env + 1) & 0xff;
          if (this.env === 0xff) { this.state = DECAY_SUSTAIN; this.ratePeriod = RATE_PERIOD[this.ad & 15]; }
        } else if (this.state === DECAY_SUSTAIN) {
          if (this.env !== (this.sr >> 4) * 17) this.env = (this.env - 1) & 0xff;
        } else {
          this.env = (this.env - 1) & 0xff;
        }
        if (this.env === 0) this.holdZero = true;
      }
    }
  }
}

class SidSynth {
  constructor(sampleRate, latency = 0.06) {
    this.sampleRate = sampleRate;
    this.v = [new Voice(), new Voice(), new Voice()];
    this.fc = 0; this.resFilt = 0; this.modeVol = 0x0f;
    this.bp = 0; this.lp = 0;
    this.queue = [];              // {t (seconds of emulated time), reg, v}
    this.emuTime = 0;             // emulated seconds corresponding to the current audio sample
    this.started = false;
    this.latency = latency;
    this.cyclesPerSample = PAL_CLOCK / sampleRate;
    this.cycleFrac = 0;
  }

  onMessage(msg) {
    if (msg.type === 'frame') {
      // msg.t = emulated start time of this frame (s); writes carry line position 0..311
      if (!this.started) { this.emuTime = msg.t - this.latency; this.started = true; }
      // if the audio clock drifted far behind (tab stall), jump forward
      if (msg.t - this.emuTime > 0.5) this.emuTime = msg.t - this.latency;
      for (const w of msg.writes) this.queue.push({ t: msg.t + (w.line / 312) * 0.02, reg: w.reg, v: w.v });
    } else if (msg.type === 'state') {
      for (let r = 0; r < 25; r++) this.write(r, msg.regs[r]);
    } else if (msg.type === 'reset') {
      this.queue.length = 0; this.started = false;
    }
  }

  write(reg, val) {
    if (reg < 21) {
      const vo = this.v[(reg / 7) | 0];
      switch (reg % 7) {
        case 0: vo.freq = (vo.freq & 0xff00) | val; break;
        case 1: vo.freq = (vo.freq & 0xff) | (val << 8); break;
        case 2: vo.pw = (vo.pw & 0xf00) | val; break;
        case 3: vo.pw = (vo.pw & 0xff) | ((val & 15) << 8); break;
        case 4: vo.setCtrl(val); break;
        case 5: vo.setAD(val); break;
        case 6: vo.setSR(val); break;
      }
    } else if (reg === 21) this.fc = (this.fc & 0x7f8) | (val & 7);
    else if (reg === 22) this.fc = (this.fc & 7) | (val << 3);
    else if (reg === 23) this.resFilt = val;
    else if (reg === 24) this.modeVol = val;
  }

  waveform(i) {
    const vo = this.v[i];
    const ctrl = vo.ctrl;
    const wf = ctrl >> 4;
    if (!wf) return 0x800;
    const acc = vo.acc;
    let out = 0xfff;
    if (wf & 1) {  // triangle (ring mod with the previous voice's MSB)
      let msb = acc & 0x800000;
      if (ctrl & 4) msb ^= this.v[(i + 2) % 3].acc & 0x800000;
      out &= ((msb ? ~acc : acc) >> 11) & 0xfff;
    }
    if (wf & 2) out &= acc >> 12;                               // sawtooth
    if (wf & 4) out &= (acc >> 12) >= vo.pw ? 0xfff : 0;          // pulse
    if (wf & 8) {                                                // noise
      const l = vo.lfsr;
      // LFSR bits 20,18,14,11,9,5,2,0 -> output bits 11..4
      const n = ((l >> 9) & 0x800) | ((l >> 8) & 0x400) | ((l >> 5) & 0x200) | ((l >> 3) & 0x100) |
        ((l >> 2) & 0x080) | ((l << 1) & 0x040) | ((l << 3) & 0x020) | ((l << 4) & 0x010);
      out &= n;
    }
    return out;
  }

  // fill one block of samples (other channels get a copy)
  render(out, ...copies) {
    const sampleRate = this.sampleRate;
    const q = this.queue;
    const dt = 1 / sampleRate;
    const v0 = this.v[0], v1 = this.v[1], v2 = this.v[2];
    // filter coefficients change only with register writes; recompute per block
    let fcHz = 30 + this.fc * 5.8;
    let g = Math.tan(Math.PI * Math.min(fcHz, sampleRate * 0.45) / sampleRate);
    let k = 1.41 - ((this.resFilt >> 4) / 15) * 1.2;
    for (let s = 0; s < out.length; s++) {
      let changed = false;
      while (q.length && q[0].t <= this.emuTime) { const w = q.shift(); this.write(w.reg, w.v); changed = true; }
      if (changed) {
        fcHz = 30 + this.fc * 5.8;
        g = Math.tan(Math.PI * Math.min(fcHz, sampleRate * 0.45) / sampleRate);
        k = 1.41 - ((this.resFilt >> 4) / 15) * 1.2;
      }
      this.emuTime += dt;
      this.cycleFrac += this.cyclesPerSample;
      const n = this.cycleFrac | 0;
      this.cycleFrac -= n;
      // oscillators; hard sync resets a voice when the previous voice's MSB rises
      const m0 = v0.acc & 0x800000, m1 = v1.acc & 0x800000, m2 = v2.acc & 0x800000;
      for (let i = 0; i < 3; i++) {
        const vo = this.v[i];
        if (vo.ctrl & 8) continue;
        const old = vo.acc;
        vo.acc = (vo.acc + vo.freq * n) & 0xffffff;
        let rises = ((vo.acc >> 19) - (old >> 19)) & 31;
        if (rises > 8) rises = 8;
        for (let r = 0; r < rises; r++) {
          const bit = ((vo.lfsr >> 22) ^ (vo.lfsr >> 17)) & 1;
          vo.lfsr = ((vo.lfsr << 1) | bit) & 0x7fffff;
        }
      }
      if ((v0.ctrl & 2) && !m2 && (v2.acc & 0x800000)) v0.acc = 0;
      if ((v1.ctrl & 2) && !m0 && (v0.acc & 0x800000)) v1.acc = 0;
      if ((v2.ctrl & 2) && !m1 && (v1.acc & 0x800000)) v2.acc = 0;
      let direct = 0, filt = 0;
      for (let i = 0; i < 3; i++) {
        const vo = this.v[i];
        vo.clockEnv(n);
        if (!vo.env) continue;
        const sample = ((this.waveform(i) - 0x800) * vo.env) / (0x800 * 255);
        if (this.resFilt & (1 << i)) filt += sample;
        else if (!(i === 2 && (this.modeVol & 0x80))) direct += sample;
      }
      // TPT state-variable filter (stable at any cutoff)
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      const v3 = filt - this.lp;
      const bp = a1 * this.bp + a2 * v3;
      const lp = this.lp + a2 * this.bp + a3 * v3;
      this.bp = 2 * bp - this.bp;
      this.lp = 2 * lp - this.lp;
      const hp = filt - k * bp - lp;
      let fo = 0;
      if (this.modeVol & 0x10) fo += lp;
      if (this.modeVol & 0x20) fo += bp;
      if (this.modeVol & 0x40) fo += hp;
      const vol = (this.modeVol & 15) / 15;
      out[s] = Math.max(-1, Math.min(1, (direct + fo) * vol * 0.24));
    }
    for (const c of copies) c.set(out);
  }
}


// The SID emulation (sid-synth.js) as an AudioWorklet processor: register writes come in on the port.

class SidProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.synth = new SidSynth(sampleRate);
    this.port.onmessage = (e) => this.synth.onMessage(e.data);
  }

  process(inputs, outputs) {
    const [first, ...rest] = outputs[0];
    this.synth.render(first, ...rest);
    return true;
  }
}

registerProcessor('sid', SidProcessor);
