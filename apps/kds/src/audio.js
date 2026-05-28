// Audio playback for new-order chime.
//
// Browsers block <audio> autoplay until the user has interacted with the
// document. We hold the AudioContext + buffer ready, and "unlock" it on the
// first tap. A small banner in the UI nudges staff to tap once.
//
// Rate-limited to one ding per 3 s so a sudden burst of orders doesn't
// machine-gun the kitchen.

let ctx = null;
let buffer = null;
let unlocked = false;
let lastPlayed = 0;

const DING_URL = "/sounds/ding.mp3";

async function ensureBuffer() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (buffer) return;
  const response = await fetch(DING_URL);
  if (!response.ok) return; // Missing asset is non-fatal; visuals still work.
  const arrayBuffer = await response.arrayBuffer();
  buffer = await ctx.decodeAudioData(arrayBuffer);
}

export async function unlockAudio() {
  if (unlocked) return;
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") await ctx.resume();
    await ensureBuffer();
    unlocked = true;
  } catch {
    unlocked = false;
  }
}

export function isAudioUnlocked() {
  return unlocked;
}

export function ding() {
  if (!unlocked || !ctx || !buffer) return;
  const now = Date.now();
  if (now - lastPlayed < 3000) return;
  lastPlayed = now;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}
