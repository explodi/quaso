// SPDX-License-Identifier: MIT
/** Cosmetic feedback lives here so the game rules stay small. */
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let audio;
let enabled = false;

export function setSound(value) {
  enabled = value;
  if (enabled) {
    audio ??= new AudioContext();
    audio.resume();
  }
}

export function sound(kind, pitch = 1) {
  if (!enabled || !audio) return;
  const notes = {
    collect: [660, 880],
    dash: [240, 480],
    pet: [520, 660, 520],
    win: [523, 659, 784, 1047],
    start: [392, 523],
  };
  (notes[kind] ?? notes.collect).forEach((frequency, index) => {
    const start = audio.currentTime + index * 0.075;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency * pitch, start);
    volume.gain.setValueAtTime(0, start);
    volume.gain.linearRampToValueAtTime(0.09, start + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
  });
}

export function bounce(element) {
  if (reducedMotion.matches) return;
  element.animate(
    [
      { scale: "1" },
      { scale: "1.18 0.83", offset: 0.3 },
      { scale: "0.95 1.08", offset: 0.6 },
      { scale: "1" },
    ],
    { duration: 300, easing: "ease-out" },
  );
}

export function burst(
  container,
  x,
  y,
  { count = 12, colors = ["#ffe59a", "#f59628", "#ffffff"] } = {},
) {
  if (reducedMotion.matches) return;
  for (let index = 0; index < count; index++) {
    const particle = document.createElement("i");
    particle.className = "particle";
    particle.style.left = `${x}%`;
    particle.style.top = `${y}%`;
    particle.style.background = colors[index % colors.length];
    container.append(particle);
    const angle = (index / count) * Math.PI * 2;
    const distance = 25 + Math.random() * 60;
    const animation = particle.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        {
          transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance - 30}px) rotate(130deg) scale(0)`,
          opacity: 0,
        },
      ],
      { duration: 500 + Math.random() * 350, easing: "cubic-bezier(.1,.7,.3,1)" },
    );
    animation.onfinish = () => particle.remove();
  }
}

export function floatText(container, text, x, y) {
  const label = document.createElement("span");
  label.className = "floating-text";
  label.textContent = text;
  label.style.left = `${x}%`;
  label.style.top = `${y}%`;
  container.append(label);
  const animation = label.animate(
    [
      { transform: "translate(-50%, -20px)", opacity: 1 },
      { transform: `translate(-50%, ${reducedMotion.matches ? "-20" : "-75"}px)`, opacity: 0 },
    ],
    { duration: 1100, easing: "ease-out" },
  );
  animation.onfinish = () => label.remove();
}
