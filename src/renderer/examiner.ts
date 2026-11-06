// src/renderer/examiner.ts
// A flat illustrated external examiner: spectacles, a tea cup, an attendance
// register. Five SVG states, swapped by mood. No face tracking of the
// examiner — this is a drawing, not a camera.

import type { Mood } from '../shared/types';

const SKIN = '#dfa67c';
const SKIN_SHADE = '#c58a62';
const HAIR = '#3b3733';
const GREY = '#8d877b';
const KURTA = '#cfd6d9';
const KURTA_SHADE = '#b6bfc3';
const INK = '#2a2a28';

function eyes(mood: Mood): string {
  if (mood === 'encouraging') {
    // happy arcs
    return `
      <path d="M130 159 Q139 148 148 159" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M172 159 Q181 148 190 159" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`;
  }
  if (mood === 'patient') {
    // eyes closed, waiting
    return `
      <path d="M130 158 Q139 165 148 158" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M172 158 Q181 165 190 158" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`;
  }
  const r = mood === 'listening' ? 5 : 4.4;
  return `
    <circle cx="139" cy="158" r="${r}" fill="${INK}"/>
    <circle cx="181" cy="158" r="${r}" fill="${INK}"/>`;
}

function brows(mood: Mood): string {
  switch (mood) {
    case 'curious':
      return `
        <path d="M126 130 L150 128" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>
        <path d="M170 120 Q181 111 194 119" fill="none" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>`;
    case 'encouraging':
      return `
        <path d="M126 128 Q138 120 150 127" fill="none" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>
        <path d="M170 127 Q182 120 194 128" fill="none" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>`;
    case 'listening':
      return `
        <path d="M125 124 Q138 115 151 123" fill="none" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>
        <path d="M169 123 Q182 115 195 124" fill="none" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>`;
    case 'patient':
      return `
        <path d="M126 130 L150 130" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>
        <path d="M170 130 L194 130" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>`;
    default:
      return `
        <path d="M126 130 L150 129" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>
        <path d="M170 129 L194 130" stroke="${HAIR}" stroke-width="4" stroke-linecap="round"/>`;
  }
}

function mouth(mood: Mood): string {
  switch (mood) {
    case 'encouraging':
      return `<path d="M144 194 Q160 208 176 194" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`;
    case 'curious':
      return `<ellipse cx="160" cy="198" rx="7" ry="8.5" fill="#7a3f36"/>`;
    case 'listening':
      return `<ellipse cx="160" cy="198" rx="6" ry="9" fill="#7a3f36"/>`;
    case 'patient':
      return `<path d="M148 196 Q160 204 172 196" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`;
    default:
      return `<path d="M147 197 L173 197" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>`;
  }
}

function teaCup(): string {
  return `
    <g class="tea">
      <path d="M232 292 C246 286 256 262 252 234" fill="none" stroke="${KURTA}" stroke-width="26" stroke-linecap="round"/>
      <path d="M232 292 C246 286 256 262 252 234" fill="none" stroke="${KURTA_SHADE}" stroke-width="26" stroke-linecap="round" opacity=".35"/>
      <circle cx="252" cy="228" r="12.5" fill="${SKIN}"/>
      <path d="M238 200 h26 l-3.5 22 q-9.5 6 -19 0 Z" fill="#f4efe2" stroke="#cfc7b2" stroke-width="1.5"/>
      <path d="M264 205 q12 4 0 13" fill="none" stroke="#cfc7b2" stroke-width="3"/>
      <ellipse cx="251" cy="200" rx="13" ry="3.6" fill="#c9a26a"/>
      <g class="steam" stroke="#ffffff" stroke-width="2.4" fill="none" opacity=".55" stroke-linecap="round">
        <path d="M245 192 q-4 -8 1 -15"/>
        <path d="M255 192 q4 -9 -1 -17"/>
      </g>
    </g>`;
}

export function examinerSvg(mood: Mood): string {
  const tilt = mood === 'curious' ? -3 : mood === 'encouraging' ? 2.5 : mood === 'listening' ? 3 : 0;

  return `
<svg viewBox="0 0 320 350" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <!-- shoulders / kurta -->
  <path d="M46 350 C 50 272 100 236 160 236 C 220 236 270 272 274 350 Z" fill="${KURTA}"/>
  <path d="M160 236 C 186 236 208 246 224 262 L 196 350 L 160 350 Z" fill="${KURTA_SHADE}" opacity=".55"/>
  <!-- collar -->
  <path d="M138 240 L160 268 L182 240 L172 234 L160 250 L148 234 Z" fill="#eef2f3"/>
  <!-- buttons -->
  <circle cx="160" cy="286" r="2.6" fill="#9aa5a9"/>
  <circle cx="160" cy="308" r="2.6" fill="#9aa5a9"/>

  <!-- neck -->
  <rect x="141" y="198" width="38" height="52" rx="12" fill="${SKIN_SHADE}"/>

  <g transform="rotate(${tilt} 160 170)">
    <!-- ears -->
    <ellipse cx="100" cy="160" rx="9" ry="15" fill="${SKIN}"/>
    <ellipse cx="220" cy="160" rx="9" ry="15" fill="${SKIN}"/>

    <!-- head -->
    <ellipse cx="160" cy="152" rx="60" ry="70" fill="${SKIN}"/>
    <path d="M160 82 C 196 82 220 108 220 150 C 210 118 190 104 160 104 C 130 104 110 118 100 150 C 100 108 124 82 160 82 Z" fill="${SKIN_SHADE}" opacity=".25"/>

    <!-- hair -->
    <path d="M99 132 C 100 76 126 56 160 56 C 198 56 221 78 221 132 C 214 106 196 90 160 90 C 124 90 106 106 99 132 Z" fill="${HAIR}"/>
    <ellipse cx="107" cy="126" rx="7" ry="16" fill="${GREY}" opacity=".85"/>
    <ellipse cx="213" cy="126" rx="7" ry="16" fill="${GREY}" opacity=".85"/>

    ${brows(mood)}
    ${eyes(mood)}

    <!-- spectacles -->
    <g fill="none" stroke="${INK}" stroke-width="3.4">
      <rect x="117" y="139" width="45" height="38" rx="10"/>
      <rect x="158" y="139" width="45" height="38" rx="10"/>
      <path d="M162 156 L158 156"/>
      <path d="M117 152 L100 148"/>
      <path d="M203 152 L220 148"/>
    </g>

    <!-- nose -->
    <path d="M160 160 Q155 178 163 180" fill="none" stroke="${SKIN_SHADE}" stroke-width="3.2" stroke-linecap="round"/>

    <!-- moustache -->
    <path d="M137 188 Q160 176 183 188 Q160 197 137 188 Z" fill="${HAIR}" opacity=".92"/>

    ${mouth(mood)}
  </g>

  ${mood === 'patient' ? teaCup() : ''}
</svg>`;
}
