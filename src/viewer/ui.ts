/**
 * The swarm's healbot: a single-file HTML page for watching the hive work.
 * Served verbatim by src/viewer/server.ts at GET /. No frameworks, no CDN —
 * everything inline. The embedded script deliberately avoids backticks and
 * template interpolation so the whole page can live in one template literal.
 */

export const VIEWER_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarmlord</title>
<style>
  :root {
    --bg: #0d0a12;
    --panel: #161020;
    --panel-2: #1c1428;
    --border: #2c2140;
    --border-bright: #43315e;
    --text: #cfc5e0;
    --dim: #7d6f96;
    --faint: #4e4463;
    --green: #7dff5e;
    --green-dim: #3f8c2f;
    --magenta: #e13fae;
    --amber: #e8b44f;
    --cyan: #4fd8e8;
    --blue: #6f86c9;
    --red: #ff5e5e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    /* creep: biomass bleeding in from the corners, very low contrast */
    background:
      radial-gradient(1100px 700px at 0% 0%,   rgba(94, 44, 128, 0.14), transparent 62%),
      radial-gradient(900px 620px at 100% 100%, rgba(225, 63, 174, 0.07), transparent 60%),
      radial-gradient(760px 520px at 100% 0%,   rgba(63, 140, 47, 0.05), transparent 58%),
      radial-gradient(820px 560px at 0% 100%,   rgba(125, 255, 94, 0.045), transparent 58%),
      radial-gradient(340px 200px at 6% 97%,    rgba(125, 255, 94, 0.05), transparent 72%),
      radial-gradient(300px 220px at 97% 4%,    rgba(225, 63, 174, 0.05), transparent 72%),
      var(--bg);
    color: var(--text);
    font-family: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    overflow: hidden;
  }
  /* faint scanlines over everything */
  body::after {
    content: '';
    position: fixed; inset: 0;
    pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(0,0,0,0.14) 0 1px, transparent 1px 3px);
    opacity: 0.5;
    z-index: 99;
  }

  /* ---- header: hive banner ---- */
  header {
    position: relative;
    display: flex; align-items: center; gap: 18px;
    height: 58px; padding: 0 18px;
    background: linear-gradient(180deg, #1a1130, #0f0a18);
    border-bottom: 1px solid var(--border-bright);
    overflow: hidden;
  }
  .banner-art {
    position: absolute; inset: 0; z-index: 0;
    width: 100%; height: 100%;
    object-fit: cover; object-position: center 28%;
    opacity: .5;
    filter: saturate(.95) brightness(.85);
    pointer-events: none; user-select: none;
  }
  /* heavy dark overlay so the wordmark stays legible; looks intentional even
     with no art behind it */
  header::before {
    content: '';
    position: absolute; inset: 0; z-index: 1;
    background:
      linear-gradient(90deg, rgba(13,10,18,0.94) 0%, rgba(13,10,18,0.66) 38%, rgba(13,10,18,0.88) 100%),
      linear-gradient(180deg, rgba(13,10,18,0.30), rgba(13,10,18,0.85));
    pointer-events: none;
  }
  /* bottom seam of the banner */
  header::after {
    content: '';
    position: absolute; left: 0; right: 0; bottom: 0; height: 1px; z-index: 2;
    background: linear-gradient(90deg, rgba(125,255,94,0.55), rgba(67,49,94,0.8) 35%, rgba(67,49,94,0.8) 70%, rgba(225,63,174,0.5));
    pointer-events: none;
  }
  header > * { position: relative; z-index: 2; }
  .wordmark {
    position: relative;
    font-weight: 800; letter-spacing: 5px; font-size: 16px;
    color: #e6e0d2;
    text-shadow: 0 0 10px rgba(230,224,210,0.30), 0 1px 2px rgba(0,0,0,0.8);
    user-select: none;
    padding-bottom: 2px;
  }
  .wordmark em { color: inherit; font-style: normal; text-shadow: inherit; }
  /* bioluminescent seam under the wordmark, slow ambient pulse */
  .wordmark::after {
    content: '';
    position: absolute; left: 0; right: 4px; bottom: -5px; height: 2px;
    background: linear-gradient(90deg, var(--green), var(--magenta));
    animation: seam-breathe 5.2s ease-in-out infinite;
  }
  @keyframes seam-breathe { 0%, 100% { opacity: .3; } 50% { opacity: .85; } }
  .vitals { display: flex; align-items: center; gap: 18px; flex: 1; min-width: 0; }
  .vital { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 10px; letter-spacing: 1.5px; white-space: nowrap; }
  .vital b { color: var(--text); font-weight: 600; font-size: 11px; letter-spacing: 0; }
  .turnbar { width: 120px; height: 4px; background: #241a36; border: 1px solid var(--border); }
  .turnbar i {
    display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--green-dim), var(--green));
    transition: width .4s ease;
  }
  .turnbar.hot i { background: linear-gradient(90deg, #8c5a2f, var(--amber)); }
  /* unlimited turns: no fill percentage, just a slow ambient pulse */
  .turnbar.inf i {
    width: 100%; transition: none;
    background: linear-gradient(90deg, var(--green-dim), var(--green), var(--green-dim));
    animation: inf-pulse 2.6s ease-in-out infinite;
  }
  @keyframes inf-pulse { 0%, 100% { opacity: .2; } 50% { opacity: .85; } }
  .conn { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--dim); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
  .dot.live { background: var(--green); box-shadow: 0 0 7px var(--green); animation: breathe 2.4s ease-in-out infinite; }
  .dot.recon { background: var(--amber); box-shadow: 0 0 7px var(--amber); animation: blink .7s steps(2) infinite; }
  .dot.paused { background: var(--amber); box-shadow: 0 0 7px var(--amber); animation: breathe 2.4s ease-in-out infinite; }
  .conn .paused-label { color: var(--amber); }
  @keyframes breathe { 50% { opacity: .55; } }
  @keyframes blink { 50% { opacity: .2; } }

  /* ---- layout ---- */
  main { display: flex; height: calc(100% - 58px); }
  #brood {
    width: 340px; min-width: 260px; flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: rgba(22, 16, 32, 0.78);
    box-shadow: inset -14px 0 28px rgba(0,0,0,0.25);
    display: flex; flex-direction: column; overflow: hidden;
  }
  #broodscroll { flex: 1; overflow-y: auto; padding: 10px; }
  #boardcol { flex: 1; display: flex; flex-direction: column; min-width: 0; }

  .coltitle {
    font-size: 10px; letter-spacing: 3px; color: var(--faint);
    padding: 2px 2px 8px; user-select: none;
  }
  .bartitle { padding: 0 6px 0 0; }

  /* ---- brood frames: chitin plates ----
     outer element paints the bioluminescent seam; ::before is the plate face
     inset 1px; ::after is the synapse-glow overlay (opacity-only animation). */
  .frame {
    --edge: #574b6e;
    position: relative;
    background: linear-gradient(150deg, rgba(125,255,94,0.40), var(--border-bright) 28%, #241a36 62%, rgba(225,63,174,0.30));
    clip-path: polygon(14px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 10px);
    padding: 8px 10px 8px 14px;
    margin-bottom: 9px;
    animation: spawn-in .4s ease-out;
    transition: opacity .3s, filter .3s, transform .12s ease;
    cursor: pointer;
  }
  .frame::before {
    content: '';
    position: absolute; inset: 1px; z-index: 0;
    background: linear-gradient(165deg, var(--panel-2), #171023 70%);
    clip-path: polygon(13px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 9px);
    border-left: 3px solid var(--edge);
    /* dark plate edge just inside the seam + carapace depth */
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.45), inset 0 12px 26px rgba(0,0,0,0.30);
    transition: border-color .3s;
  }
  .frame::after {
    content: '';
    position: absolute; inset: 1px; z-index: 0;
    clip-path: polygon(13px 0, 100% 0, 100% calc(100% - 11px), calc(100% - 11px) 100%, 0 100%, 0 9px);
    background: radial-gradient(120% 95% at 45% 50%, rgba(125,255,94,0.14), transparent 72%);
    opacity: 0;
    pointer-events: none;
  }
  .frame > * { position: relative; z-index: 1; }
  /* skitter on spawn */
  @keyframes spawn-in {
    0%   { opacity: 0; transform: translateX(-16px) rotate(-1.2deg); }
    55%  { opacity: 1; transform: translateX(3px) rotate(.4deg); }
    80%  { transform: translateX(-1px) rotate(0deg); }
    100% { transform: none; }
  }
  .frame.st-ready { --edge: var(--green); }
  .frame.st-idle  { --edge: #b08a2e; opacity: .72; }           /* dormant spore */
  .frame.st-done  { --edge: #6b7a94; opacity: .45; filter: saturate(.2) contrast(.92); }  /* dried husk */
  /* firing synapse: ready frames glow slow, thinking frames pulse hard */
  .frame.st-ready::after { animation: synapse 2.8s ease-in-out infinite; }
  .frame.thinking::after { animation: synapse 1.5s ease-in-out infinite; }
  .frame.thinking { filter: drop-shadow(0 0 7px rgba(125,255,94,0.28)); }
  @keyframes synapse { 0%, 100% { opacity: .18; } 50% { opacity: 1; } }
  .frame.flash::after {
    background: rgba(225,63,174,0.30);
    animation: frame-flash .5s ease-out forwards;
  }
  @keyframes frame-flash { from { opacity: 1; } to { opacity: 0; } }
  .fhead { display: flex; align-items: baseline; gap: 7px; }
  .fname { font-weight: 700; color: var(--text); }
  .frole { color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .fstatus { font-size: 10px; letter-spacing: 1px; }
  .st-ready .fstatus { color: var(--green); }
  .st-idle  .fstatus { color: #b08a2e; }
  .st-done  .fstatus { color: var(--blue); }
  .factivity {
    color: var(--dim); font-size: 11px; margin-top: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fmeta { display: flex; gap: 10px; margin-top: 4px; font-size: 10px; color: var(--faint); align-items: center; }
  .wakes {
    background: rgba(225,63,174,0.18); color: var(--magenta);
    border: 1px solid rgba(225,63,174,0.5);
    padding: 0 5px; border-radius: 8px; font-size: 10px;
  }
  .fadapter {
    color: var(--faint); font-size: 9px; letter-spacing: .5px;
    border: 1px solid var(--border); padding: 0 4px;
    max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ftier {
    font-size: 9px; letter-spacing: .5px;
    border: 1px solid; padding: 0 4px;
    white-space: nowrap;
  }
  .ftier.tier-heavy    { color: var(--magenta); border-color: rgba(225,63,174,0.5);  background: rgba(225,63,174,0.10); }
  .ftier.tier-standard { color: #a98fd6;        border-color: rgba(151,113,209,0.5); background: rgba(151,113,209,0.10); }
  .ftier.tier-light    { color: var(--green);   border-color: rgba(125,255,94,0.4);  background: rgba(125,255,94,0.08); }
  .ptag { color: var(--faint); font-size: 9px; }
  .empty { color: var(--faint); text-align: center; padding: 28px 8px; font-size: 12px; }
  /* hover: lift the plate, run current through the seam (box-shadow is eaten
     by the clip-path, so drop-shadow does the glow like .thinking does) */
  .frame:hover {
    transform: translateY(-2px);
    filter: drop-shadow(0 0 9px rgba(125,255,94,0.32));
    background: linear-gradient(150deg, rgba(125,255,94,0.85), var(--border-bright) 28%, #2c2140 62%, rgba(225,63,174,0.65));
  }
  /* pinned filter: persistent bright seam (placed after st-* so --edge wins) */
  .frame.selected {
    --edge: var(--green);
    background: linear-gradient(150deg, var(--green), rgba(125,255,94,0.45) 28%, #2c2140 62%, var(--magenta));
  }

  /* ---- hierarchy tree: indented rows + lineage veins ----
     each frame sits in a .frow wrapper indented by depth; children carry an
     L-shaped vein tying them back up to their parent. veins brighten when
     their lineage is hovered. */
  .frow { position: relative; }
  .vein {
    position: absolute;
    left: -9px; top: -12px; bottom: 58%;
    width: 8px;
    border-left: 1px solid rgba(151, 113, 209, 0.28);
    border-bottom: 1px solid rgba(151, 113, 209, 0.28);
    pointer-events: none;
    transition: border-color .25s ease;
  }
  .frow:hover > .vein, .vein.lit {
    border-left-color: rgba(196, 160, 255, 0.7);
    border-bottom-color: rgba(196, 160, 255, 0.7);
  }

  /* ---- hover inspector card: floating chitin plate ---- */
  #hovercard {
    display: none;
    position: fixed; z-index: 80;
    width: 360px; max-width: 92vw; max-height: 70vh; overflow-y: auto;
    background: linear-gradient(165deg, var(--panel-2), #171023 70%);
    border: 1px solid var(--border-bright);
    box-shadow: 0 14px 40px rgba(0,0,0,0.6);
    padding: 10px 12px 12px 15px;
    font-size: 12px;
  }
  /* bioluminescent seam down the card's leading edge, same as the drawer */
  #hovercard::before {
    content: '';
    position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: linear-gradient(180deg, rgba(125,255,94,0.7), var(--border-bright) 30%, var(--border-bright) 70%, rgba(225,63,174,0.6));
    pointer-events: none;
  }
  #hovercard .hc-head { display: flex; align-items: baseline; gap: 8px; }
  #hovercard .hc-name { font-size: 15px; font-weight: 800; color: var(--text); flex: 1; }
  #hovercard .hc-role { color: var(--dim); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
  #hovercard .hc-line { display: flex; align-items: baseline; gap: 8px; margin-top: 7px; }
  #hovercard .hc-key { color: var(--faint); font-size: 10px; letter-spacing: 1.5px; white-space: nowrap; }
  #hovercard .hc-val { color: var(--text); overflow-wrap: anywhere; }
  #hovercard .hc-ago { color: var(--faint); font-size: 10px; }
  #hovercard .hc-body {
    margin-top: 3px; color: var(--text); font-size: 12px; line-height: 1.45;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  #hovercard .hc-evt { display: flex; align-items: baseline; gap: 6px; margin-top: 4px; font-size: 11px; }
  #hovercard .hc-evt .eid { flex-shrink: 0; }
  #hovercard .hc-evt .echan { flex-shrink: 0; max-width: 90px; }
  #hovercard .hc-ebody { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #hovercard .hc-none { color: var(--faint); }

  /* ---- board ---- */
  /* pinned strip: membrane sac */
  #pinstrip {
    display: none; padding: 7px 12px;
    background: linear-gradient(180deg, rgba(225,63,174,0.10), rgba(225,63,174,0.05));
    border-bottom: 1px solid rgba(225,63,174,0.35);
    box-shadow: inset 0 -10px 20px rgba(225,63,174,0.05);
    flex-wrap: wrap; gap: 6px;
  }
  #pinstrip.haspins { display: flex; }
  .pinchip {
    border: 1px solid rgba(225,63,174,0.45); color: #f0a8d6;
    background: rgba(225,63,174,0.10);
    border-radius: 10px;
    padding: 2px 9px; font-size: 11px;
    max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pinchip .by { color: var(--dim); }

  #boardbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--border);
    background: rgba(22, 16, 32, 0.78); flex-wrap: wrap;
  }
  .tab {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer;
  }
  .tab:hover { border-color: var(--green-dim); color: var(--text); }
  .tab.active { border-color: var(--magenta); color: var(--magenta); background: rgba(225,63,174,0.08); }
  .tab .cnt { color: var(--faint); margin-left: 4px; }
  #filter {
    margin-left: auto; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 3px 8px; width: 180px; outline: none;
  }
  #filter:focus { border-color: var(--green-dim); }
  #followbtn {
    background: none; border: 1px solid var(--border); color: var(--faint);
    font: inherit; font-size: 10px; letter-spacing: 1px; padding: 3px 9px; cursor: pointer;
  }
  #followbtn.on { color: var(--green); border-color: var(--green-dim); }
  #agentchip {
    display: none;
    background: rgba(125,255,94,0.08); border: 1px solid var(--green-dim); color: var(--green);
    font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 10px; cursor: pointer;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #agentchip:hover { background: rgba(125,255,94,0.16); }

  #feed { flex: 1; overflow-y: auto; padding: 6px 0 24px; }
  /* event rows: thin vein down the left edge, glows briefly as the row lands */
  .evt {
    display: grid;
    grid-template-columns: 52px 110px 110px 130px 1fr;
    gap: 8px; padding: 4px 12px 4px 10px;
    border-bottom: 1px solid #171024;
    border-left: 2px solid rgba(125,255,94,0.10);
    align-items: baseline;
    animation: row-in .6s ease-out;
    transition: opacity .18s ease;
  }
  /* spotlight while a brood frame is hovered */
  .evt.spot-dim { opacity: .25; }
  .evt.spot-on { border-left-color: rgba(125,255,94,0.75); }
  @keyframes row-in {
    0%   { opacity: 0; border-left-color: rgba(125,255,94,0.9); }
    30%  { opacity: 1; border-left-color: rgba(125,255,94,0.6); }
    100% { border-left-color: rgba(125,255,94,0.10); }
  }
  .evt:hover { background: rgba(255,255,255,0.02); border-left-color: rgba(125,255,94,0.35); }
  .eid { color: var(--faint); font-size: 11px; text-align: right; }
  .badge {
    font-size: 10px; letter-spacing: .5px; text-align: center;
    border: 1px solid; padding: 1px 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .t-post           { color: var(--green);   border-color: rgba(125,255,94,0.4); }
  .t-spawned        { color: var(--magenta); border-color: rgba(225,63,174,0.5); }
  .t-claimed, .t-claim_released { color: #e8b44f; border-color: rgba(232,180,79,0.4); }
  .t-channel_created, .t-channel_merged { color: var(--cyan); border-color: rgba(79,216,232,0.4); }
  .t-agent_idle, .t-agent_done  { color: var(--faint); border-color: var(--border); }
  .t-pinned, .t-unpinned        { color: #d6ff5e; border-color: rgba(214,255,94,0.5); }
  .t-system         { color: var(--red); border-color: rgba(255,94,94,0.5); }
  .eagent { color: var(--text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .echan { color: var(--cyan); font-size: 11px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ebody {
    color: var(--dim); font-size: 12px; line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap;
    cursor: pointer;
  }
  .ebody.open { display: block; -webkit-line-clamp: unset; color: var(--text); }
  .duplink { color: var(--faint); font-size: 10px; }

  /* ---- settings drawer ---- */
  #gearbtn {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 14px; line-height: 1; padding: 4px 8px; cursor: pointer;
  }
  #gearbtn:hover { color: var(--text); border-color: var(--green-dim); }
  #drawer {
    position: fixed; top: 58px; right: 0; bottom: 0; z-index: 60;
    width: 400px; max-width: 92vw;
    background: linear-gradient(165deg, var(--panel-2), #171023 70%);
    border-left: 1px solid var(--border-bright);
    box-shadow: -18px 0 36px rgba(0,0,0,0.55);
    transform: translateX(105%);
    transition: transform .25s ease;
    display: flex; flex-direction: column;
  }
  #drawer.open { transform: translateX(0); }
  /* bioluminescent seam down the drawer's leading edge */
  #drawer::before {
    content: '';
    position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: linear-gradient(180deg, rgba(125,255,94,0.7), var(--border-bright) 30%, var(--border-bright) 70%, rgba(225,63,174,0.6));
    pointer-events: none;
  }
  .drawerhead {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid var(--border);
    background: rgba(22, 16, 32, 0.78);
  }
  .drawerhead .coltitle { padding: 0; }
  #drawerclose {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 11px; line-height: 1; padding: 3px 7px; cursor: pointer;
  }
  #drawerclose:hover { color: var(--magenta); border-color: rgba(225,63,174,0.5); }
  .drawerbody { flex: 1; overflow-y: auto; padding: 12px; }
  .cfgrow {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    padding: 5px 2px; border-bottom: 1px solid #171024; font-size: 12px;
  }
  .cfgkey { color: var(--faint); font-size: 10px; letter-spacing: 1.5px; white-space: nowrap; }
  .cfgval { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cfgtext { margin-top: 9px; }
  .cfgtext summary {
    cursor: pointer; user-select: none;
    color: var(--dim); font-size: 10px; letter-spacing: 1.5px; padding: 3px 2px;
  }
  .cfgtext summary:hover { color: var(--text); }
  .cfgtext pre {
    margin-top: 5px; padding: 8px;
    max-height: 200px; overflow-y: auto;
    background: rgba(13,10,18,0.6); border: 1px solid var(--border);
    color: var(--dim); font: inherit; font-size: 11px; line-height: 1.5;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  /* ---- drawer sections ---- */
  .cfgsec { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--border); }
  .sectitle { font-size: 10px; letter-spacing: 3px; color: var(--faint); margin-bottom: 8px; user-select: none; }
  .sliderrow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 11px; color: var(--dim); }
  .sliderrow > label:first-child { width: 92px; flex-shrink: 0; }
  .sliderrow input[type=range] { flex: 1; min-width: 0; accent-color: var(--green); }
  .sliderrow input[type=range]:disabled { opacity: .35; }
  .sliderrow b { color: var(--text); font-size: 11px; width: 44px; text-align: right; flex-shrink: 0; }
  .infbox { display: flex; align-items: center; gap: 3px; color: var(--dim); font-size: 12px; cursor: pointer; flex-shrink: 0; white-space: nowrap; }
  .infbox input { accent-color: var(--magenta); cursor: pointer; }
  .applyrow { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .applybtn {
    background: none; border: 1px solid var(--green-dim); color: var(--green);
    font: inherit; font-size: 11px; letter-spacing: 1px; padding: 4px 12px; cursor: pointer;
  }
  .applybtn:hover { background: rgba(125,255,94,0.08); }
  .secmsg { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .secmsg.ok { color: var(--green); }
  .secmsg.err { color: var(--magenta); }
  .tierrow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .tierrow .ftier { width: 66px; text-align: center; flex-shrink: 0; }
  .tierrow select {
    flex: 1; min-width: 0;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 3px 6px; outline: none;
  }
  .tierrow select:focus { border-color: var(--green-dim); }
  .weightrow { display: flex; align-items: center; gap: 6px; margin: 8px 0 2px; }
  .weightrow .cfgkey { width: 66px; flex-shrink: 0; }
  .weightrow input {
    flex: 1; width: 0; min-width: 0;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 3px 6px; outline: none;
  }
  .weightrow input:focus { border-color: var(--green-dim); }
  #pausebtn {
    display: block; width: 100%; margin: 6px 0 2px;
    background: rgba(125,255,94,0.05); border: 1px solid var(--border-bright); color: var(--text);
    font: inherit; font-weight: 800; font-size: 13px; letter-spacing: 4px;
    padding: 11px; cursor: pointer;
    transition: background .2s, border-color .2s, box-shadow .2s;
  }
  #pausebtn:hover { border-color: var(--green-dim); }
  #pausebtn.paused {
    color: #fff; background: rgba(225,63,174,0.28); border-color: var(--magenta);
    box-shadow: 0 0 14px rgba(225,63,174,0.45), inset 0 0 18px rgba(225,63,174,0.18);
    text-shadow: 0 0 8px rgba(225,63,174,0.8);
  }
  #cfg-appendix {
    width: 100%; min-height: 90px; resize: vertical; margin-top: 5px;
    background: rgba(13,10,18,0.6); border: 1px solid var(--border);
    color: var(--text); font: inherit; font-size: 11px; line-height: 1.5;
    padding: 8px; outline: none;
  }
  #cfg-appendix:focus { border-color: var(--green-dim); }
  .numrow {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    color: var(--dim); font-size: 11px; margin-bottom: 6px;
  }
  .numrow input {
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 12px;
    padding: 3px 8px; width: 110px; outline: none;
  }
  .numrow input:focus { border-color: var(--green-dim); }
  .cfghint { margin-top: 8px; color: var(--faint); font-size: 11px; line-height: 1.5; }

  /* ---- direct line: command console seam at the brood's foot ---- */
  #directline {
    position: relative; flex-shrink: 0;
    background: linear-gradient(180deg, rgba(22,16,32,0.94), rgba(13,10,18,0.96));
    border-top: 1px solid var(--border-bright);
  }
  #directline::before {
    content: '';
    position: absolute; left: 0; right: 0; top: -1px; height: 1px;
    background: linear-gradient(90deg, rgba(125,255,94,0.55), rgba(67,49,94,0.8) 40%, rgba(225,63,174,0.5));
    pointer-events: none;
  }
  /* slim header strip: the whole thing is the fold toggle */
  .dlhead {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 10px; cursor: pointer; user-select: none;
  }
  .dlhead:hover .dltitle { color: var(--dim); }
  .dltitle { font-size: 9px; letter-spacing: 2.5px; color: var(--faint); transition: color .15s; }
  .dltitle em { color: var(--green); font-style: normal; }
  .dlchev {
    color: var(--faint); font-size: 8px; line-height: 1;
    transition: transform .2s ease;
  }
  #directline.open .dlchev { transform: rotate(180deg); }
  #dl-body { display: none; padding: 0 10px 8px; }
  #directline.open #dl-body { display: block; }
  .dlrow { display: flex; gap: 6px; }
  #dl-agent {
    max-width: 110px; flex-shrink: 0;
    background: var(--bg); color: var(--green);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 3px 4px; outline: none;
  }
  #dl-agent:focus { border-color: var(--green-dim); }
  #dl-text {
    flex: 1; min-width: 0;
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); font: inherit; font-size: 11px;
    padding: 4px 8px; outline: none;
  }
  #dl-text:focus { border-color: var(--green-dim); }
  #dl-send {
    flex-shrink: 0;
    background: none; border: 1px solid var(--green-dim); color: var(--green);
    font: inherit; font-size: 11px; letter-spacing: 1px; padding: 4px 10px; cursor: pointer;
  }
  #dl-send:hover { background: rgba(125,255,94,0.08); }
  #dl-err { display: none; margin-top: 5px; color: var(--magenta); font-size: 10px; overflow-wrap: anywhere; }

  /* ---- hive mode: home screen + header additions ---- */
  #hivelink {
    color: var(--dim); font-size: 11px; text-decoration: none; white-space: nowrap;
    border: 1px solid var(--border); padding: 3px 9px;
  }
  #hivelink:hover { color: var(--green); border-color: var(--green-dim); }
  #swarmtitle {
    color: var(--text); font-size: 12px; font-weight: 700;
    max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #hivehome { flex: 1; overflow-y: auto; padding: 26px 20px 48px; }
  .hivewrap { max-width: 780px; margin: 0 auto; }
  /* chitin plate, home-screen sized: same construction as .frame */
  .plate {
    position: relative;
    background: linear-gradient(150deg, rgba(125,255,94,0.40), var(--border-bright) 28%, #241a36 62%, rgba(225,63,174,0.30));
    clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 12px);
    padding: 12px 14px 12px 18px;
    margin-bottom: 12px;
  }
  .plate::before {
    content: '';
    position: absolute; inset: 1px; z-index: 0;
    background: linear-gradient(165deg, var(--panel-2), #171023 70%);
    clip-path: polygon(15px 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%, 0 11px);
    border-left: 3px solid var(--hedge, #574b6e);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.45), inset 0 12px 26px rgba(0,0,0,0.30);
  }
  .plate > * { position: relative; z-index: 1; }
  .swplate { cursor: pointer; transition: transform .12s ease, filter .3s; animation: spawn-in .4s ease-out; }
  .swplate:hover {
    transform: translateY(-2px);
    filter: drop-shadow(0 0 9px rgba(125,255,94,0.32));
  }
  .swplate.running { --hedge: var(--green); }
  .swplate.running::after {
    content: '';
    position: absolute; inset: 1px; z-index: 0;
    clip-path: polygon(15px 0, 100% 0, 100% calc(100% - 13px), calc(100% - 13px) 100%, 0 100%, 0 11px);
    background: radial-gradient(120% 95% at 45% 50%, rgba(125,255,94,0.12), transparent 72%);
    animation: synapse 2.8s ease-in-out infinite;
    pointer-events: none;
  }
  .swplate.archived { --hedge: #6b7a94; opacity: .55; filter: saturate(.35); }
  .swplate.errored { --hedge: var(--magenta); }
  .swhead { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }
  .swtitle { font-weight: 800; font-size: 14px; color: var(--text); overflow-wrap: anywhere; }
  .swid { color: var(--faint); font-size: 10px; }
  .chip { font-size: 9px; letter-spacing: 1px; border: 1px solid; padding: 0 5px; white-space: nowrap; }
  .chip.active { color: var(--green); border-color: rgba(125,255,94,0.4); background: rgba(125,255,94,0.08); }
  .chip.archived { color: #8b98b0; border-color: #3a445a; background: rgba(107,122,148,0.10); }
  .runind { display: inline-flex; align-items: center; gap: 5px; color: var(--green); font-size: 10px; letter-spacing: 1.5px; }
  .runind i { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 7px var(--green); animation: breathe 1.6s ease-in-out infinite; }
  .swdate { margin-left: auto; color: var(--faint); font-size: 10px; white-space: nowrap; }
  .swtask { margin-top: 6px; color: var(--dim); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .swstats { margin-top: 6px; color: var(--dim); font-size: 10px; letter-spacing: 1px; }
  .swstats b { color: var(--text); font-weight: 600; letter-spacing: 0; }
  .swerr { margin-top: 6px; color: var(--magenta); font-size: 11px; overflow-wrap: anywhere; }
  .swbtns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .swbtn {
    background: none; border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 10px; letter-spacing: 1px; padding: 3px 10px; cursor: pointer;
  }
  .swbtn:hover { border-color: var(--green-dim); color: var(--text); }
  .swbtn.danger:hover { border-color: rgba(225,63,174,0.6); color: var(--magenta); }
  .newswarm input, .newswarm textarea {
    width: 100%; background: rgba(13,10,18,0.6); border: 1px solid var(--border);
    color: var(--text); font: inherit; font-size: 12px; padding: 7px 9px; outline: none;
  }
  .newswarm input:focus, .newswarm textarea:focus { border-color: var(--green-dim); }
  .newswarm textarea { min-height: 84px; resize: vertical; margin-top: 8px; line-height: 1.5; }
  .nsrow { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
  #ns-launch {
    background: rgba(125,255,94,0.05); border: 1px solid var(--green-dim); color: var(--green);
    font: inherit; font-weight: 800; font-size: 12px; letter-spacing: 3px;
    padding: 8px 22px; cursor: pointer;
  }
  #ns-launch:hover { background: rgba(125,255,94,0.12); }
  #ns-launch:disabled { opacity: .45; cursor: default; }
  #hive-msg { color: var(--magenta); font-size: 11px; min-height: 15px; margin: 0 0 8px; overflow-wrap: anywhere; }

  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-bright); }
</style>
</head>
<body>
<header>
  <img class="banner-art" src="/assets/swarmlord.png" alt="" onerror="this.style.display='none'">
  <div class="wordmark">SWARM<em>LORD</em></div>
  <a id="hivelink" href="#/" style="display:none" title="back to the hive">&#8592; hive</a>
  <span id="swarmtitle" style="display:none"></span>
  <div class="vitals" id="dashvitals">
    <div class="vital"><span>turns</span><div class="turnbar" id="turnbar"><i></i></div><b id="turnnum">0/0</b></div>
    <div class="vital"><span>agents</span><b id="agentnum">0/0</b></div>
    <div class="vital"><span>events</span><b id="eventnum">0</b></div>
  </div>
  <div class="vitals" id="hivevitals" style="display:none">
    <div class="vital"><span>swarms</span><b id="hv-total">0</b></div>
    <div class="vital"><span>running</span><b id="hv-running">0</b></div>
    <div class="vital"><span>archived</span><b id="hv-archived">0</b></div>
  </div>
  <div class="conn" id="connbox"><span id="connlabel">connecting</span><span class="dot" id="conndot"></span></div>
  <button id="gearbtn" title="settings">&#9881;</button>
</header>
<main>
  <section id="brood">
    <div id="broodscroll">
      <div class="coltitle">agents</div>
      <div id="frames"></div>
      <div class="empty" id="broodEmpty">no agents yet</div>
    </div>
    <div id="directline">
      <div class="dlhead" id="dl-head" title="toggle direct line">
        <span class="dltitle">DIRECT LINE <em>&#9657;</em> OVERSEER</span>
        <span class="dlchev">&#9650;</span>
      </div>
      <div id="dl-body">
        <div class="dlrow">
          <select id="dl-agent" title="target agent"></select>
          <input id="dl-text" type="text" placeholder="message the overseer&hellip;" spellcheck="false">
          <button id="dl-send" title="send">SEND</button>
        </div>
        <div id="dl-err"></div>
      </div>
    </div>
  </section>
  <section id="boardcol">
    <div id="pinstrip"></div>
    <div id="boardbar">
      <span class="coltitle bartitle">board</span>
      <span id="tabs"></span>
      <button id="agentchip" title="clear agent filter"></button>
      <button id="followbtn" class="on" title="auto-scroll to newest">FOLLOWING</button>
      <input id="filter" type="text" placeholder="filter…" spellcheck="false">
    </div>
    <div id="feed">
      <div class="empty" id="feedEmpty">no events yet</div>
    </div>
  </section>
  <section id="hivehome" style="display:none">
    <div class="hivewrap">
      <div class="coltitle">new swarm</div>
      <div class="plate newswarm">
        <input id="ns-title" type="text" placeholder="title (optional)" spellcheck="false">
        <textarea id="ns-task" placeholder="what should the swarm do?" spellcheck="false"></textarea>
        <div class="nsrow"><button id="ns-launch">LAUNCH</button><span class="secmsg" id="ns-msg"></span></div>
      </div>
      <div class="coltitle" style="padding-top:14px">swarms</div>
      <div id="hive-msg"></div>
      <div id="swarmlist"></div>
      <div class="empty" id="hiveEmpty" style="display:none">no swarms yet &mdash; spawn one</div>
    </div>
  </section>
</main>
<aside id="drawer">
  <div class="drawerhead">
    <span class="coltitle">settings</span>
    <button id="drawerclose" title="close">&#10005;</button>
  </div>
  <div class="drawerbody">
    <div class="cfgrow"><span class="cfgkey">adapter</span><span class="cfgval" id="cfg-adapter">&mdash;</span></div>
    <div class="cfgrow"><span class="cfgkey">root agent</span><span class="cfgval" id="cfg-root">&mdash;</span></div>

    <div class="cfgsec">
      <div class="sectitle">limits</div>
      <div class="sliderrow">
        <label for="cfg-maxturns">max total turns</label>
        <input id="cfg-maxturns" type="range" min="0" max="400" step="10">
        <b id="cfg-maxturns-val">0</b>
        <label class="infbox" title="unlimited"><input id="cfg-maxturns-inf" type="checkbox">&#8734;</label>
      </div>
      <div class="sliderrow">
        <label for="cfg-maxagents">max agents</label>
        <input id="cfg-maxagents" type="range" min="1" max="64" step="1">
        <b id="cfg-maxagents-val">1</b>
        <label class="infbox" title="unlimited"><input id="cfg-maxagents-inf" type="checkbox">&#8734;</label>
      </div>
      <div class="applyrow"><button class="applybtn" id="apply-limits">apply</button><span class="secmsg" id="msg-limits"></span></div>
      <div class="cfghint">setting max turns at or below the current count halts the run &mdash; a soft stop. &#8734; means no ceiling.</div>
    </div>

    <div class="cfgsec">
      <div class="sectitle">tiers</div>
      <div class="tierrow"><span class="ftier tier-heavy">heavy</span><select id="cfg-tier-heavy"></select></div>
      <div class="tierrow"><span class="ftier tier-standard">standard</span><select id="cfg-tier-standard"></select></div>
      <div class="tierrow"><span class="ftier tier-light">light</span><select id="cfg-tier-light"></select></div>
      <div class="weightrow">
        <span class="cfgkey">weights</span>
        <input id="cfg-w-heavy" type="number" step="any" min="0" placeholder="heavy" title="heavy weight">
        <input id="cfg-w-standard" type="number" step="any" min="0" placeholder="standard" title="standard weight">
        <input id="cfg-w-light" type="number" step="any" min="0" placeholder="light" title="light weight">
      </div>
      <div class="applyrow"><button class="applybtn" id="apply-tiers">apply</button><span class="secmsg" id="msg-tiers"></span></div>
    </div>

    <div class="cfgsec">
      <div class="sectitle">pacing</div>
      <div class="sliderrow">
        <label for="cfg-delay">turn delay</label>
        <input id="cfg-delay" type="range" min="0" max="5000" step="100">
        <b id="cfg-delay-val">0s</b>
      </div>
      <button id="pausebtn">PAUSE</button>
      <div class="applyrow"><button class="applybtn" id="apply-pacing">apply</button><span class="secmsg" id="msg-pacing"></span></div>
    </div>

    <div class="cfgsec">
      <div class="sectitle">board</div>
      <div class="numrow"><label for="cfg-pinslots">pin slots</label><input id="cfg-pinslots" type="number" min="0" step="1"></div>
      <div class="numrow"><label for="cfg-ttl">claim ttl (ms)</label><input id="cfg-ttl" type="number" min="0" step="1000"></div>
      <div class="applyrow"><button class="applybtn" id="apply-board">apply</button><span class="secmsg" id="msg-board"></span></div>
    </div>

    <div class="cfgsec">
      <div class="sectitle">protocol</div>
      <details class="cfgtext"><summary>root prompt</summary><pre id="cfg-prompt"></pre></details>
      <details class="cfgtext"><summary>protocol</summary><pre id="cfg-protocol"></pre></details>
      <textarea id="cfg-appendix" spellcheck="false" placeholder="protocol appendix&hellip;"></textarea>
      <div class="applyrow"><button class="applybtn" id="apply-protocol">apply</button><span class="secmsg" id="msg-protocol"></span></div>
    </div>
  </div>
</aside>
<div id="hovercard"></div>
<script>
(function () {
  'use strict';

  var apiBase = '';              // '' in single-swarm mode, '/s/<id>' in hive mode
  var lastSeenId = 0;
  var following = true;
  var feedHover = false;
  var activeChannel = null;      // null = All
  var filterText = '';
  var frames = {};               // agent name -> { el, activityEl, turnsEl, wakesEl, statusEl }
  var eventsById = {};           // id -> SwarmEvent (for pin body lookup)
  var agentsByName = {};         // agent name -> latest AgentSnapshot
  var eventsByAgent = {};        // agent name -> recent SwarmEvents (capped ring)
  var agentFilter = null;        // sticky feed filter: agent name or null
  var spotAgent = null;          // agent currently spotlit in the feed (frame hover)
  var cardAgent = null;          // agent shown in the hover card, null when hidden
  var cardHover = false;
  var hoverShowTimer = null;
  var hoverHideTimer = null;
  var litAgent = null;           // agent whose ancestor veins are highlighted
  var treeSig = '';              // name/parent signature; re-sort only when it changes
  var channelSig = '';
  var lastState = null;
  var es = null;
  var reconnects = 0;
  var MAX_ROWS = 3000;

  var $ = function (id) { return document.getElementById(id); };
  var feed = $('feed');
  var framesEl = $('frames');

  // ---------- connection dot (doubles as the paused beacon) ----------
  var connMode = 'connecting';
  var isPaused = false;

  function renderConn() {
    var dot = $('conndot'), label = $('connlabel');
    if (isPaused && connMode === 'live') {
      dot.className = 'dot paused';
      label.className = 'paused-label';
      label.textContent = 'paused';
      return;
    }
    label.className = '';
    dot.className = 'dot' + (connMode === 'live' ? ' live' : connMode === 'recon' ? ' recon' : '');
    label.textContent = connMode === 'live' ? 'live' : connMode === 'recon' ? 'reconnecting' : 'connecting';
  }

  function setConn(mode) { connMode = mode; renderConn(); }

  // ---------- vitals ----------
  var INF = '\\u221e';

  function renderVitals(snap) {
    var bar = $('turnbar');
    if (snap.maxTotalTurns === null || snap.maxTotalTurns === undefined) {
      // unlimited: indeterminate slow pulse instead of a fill percentage
      bar.firstElementChild.style.width = '100%';
      bar.className = 'turnbar inf';
      $('turnnum').textContent = snap.turnsTaken + '/' + INF;
    } else {
      var pct = snap.maxTotalTurns > 0 ? (snap.turnsTaken / snap.maxTotalTurns) * 100 : 0;
      bar.firstElementChild.style.width = Math.min(100, pct) + '%';
      bar.className = 'turnbar' + (pct > 80 ? ' hot' : '');
      $('turnnum').textContent = snap.turnsTaken + '/' + snap.maxTotalTurns;
    }
    var maxA = (snap.maxAgents === null || snap.maxAgents === undefined) ? INF : snap.maxAgents;
    $('agentnum').textContent = snap.agents.length + '/' + maxA;
    $('eventnum').textContent = String(snap.lastEventId);
  }

  // ---------- brood frames ----------
  function statusLabel(s) {
    return s === 'ready' ? 'READY' : s === 'idle' ? 'IDLE' : 'DONE';
  }

  function makeFrame(a) {
    var el = document.createElement('div');
    el.className = 'frame';
    var head = document.createElement('div'); head.className = 'fhead';
    var nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = a.name;
    var role = document.createElement('span'); role.className = 'frole'; role.textContent = a.role; role.title = a.role;
    var st = document.createElement('span'); st.className = 'fstatus';
    head.appendChild(nm); head.appendChild(role); head.appendChild(st);
    var act = document.createElement('div'); act.className = 'factivity';
    var meta = document.createElement('div'); meta.className = 'fmeta';
    var turns = document.createElement('span');
    var wakes = document.createElement('span'); wakes.className = 'wakes'; wakes.style.display = 'none';
    meta.appendChild(turns); meta.appendChild(wakes);
    if (a.adapter) {
      var ad = document.createElement('span'); ad.className = 'fadapter';
      ad.textContent = a.adapter; ad.title = a.adapter;
      meta.appendChild(ad);
    }
    var tier = document.createElement('span');
    tier.className = 'ftier'; tier.style.display = 'none';
    meta.appendChild(tier);
    if (a.parent) {
      var pt = document.createElement('span'); pt.className = 'ptag';
      pt.textContent = '\\u2190 ' + a.parent;
      meta.appendChild(pt);
    }
    el.appendChild(head); el.appendChild(act); el.appendChild(meta);
    el.addEventListener('mouseenter', function () { frameEnter(a.name, el); });
    el.addEventListener('mouseleave', frameLeave);
    el.addEventListener('click', function () { toggleAgentFilter(a.name); });
    var wrap = document.createElement('div'); wrap.className = 'frow';
    var vein = document.createElement('span'); vein.className = 'vein'; vein.style.display = 'none';
    wrap.appendChild(vein); wrap.appendChild(el);
    framesEl.appendChild(wrap);
    return { el: el, wrap: wrap, veinEl: vein, tierEl: tier, activityEl: act, turnsEl: turns, wakesEl: wakes, statusEl: st, spawned: false };
  }

  function patchFrame(f, a) {
    var thinking = a.status === 'ready' && a.lastActivity.indexOf('thinking') === 0;
    var cls = 'frame st-' + a.status + (thinking ? ' thinking' : '');
    if (f.el.classList.contains('flash')) cls += ' flash';
    if (agentFilter === a.name) cls += ' selected';
    f.el.className = cls;
    f.statusEl.textContent = statusLabel(a.status);
    if (f.activityEl.textContent !== a.lastActivity) {
      f.activityEl.textContent = a.lastActivity;
      f.activityEl.title = a.lastActivity;
    }
    f.turnsEl.textContent = a.turns + ' turn' + (a.turns === 1 ? '' : 's');
    if (a.pendingWakes > 0) {
      f.wakesEl.style.display = '';
      f.wakesEl.textContent = a.pendingWakes + ' wake' + (a.pendingWakes === 1 ? '' : 's');
    } else {
      f.wakesEl.style.display = 'none';
    }
    if (a.tier) {
      f.tierEl.className = 'ftier tier-' + a.tier;
      f.tierEl.textContent = a.tier;
      f.tierEl.style.display = '';
    } else {
      f.tierEl.style.display = 'none';
    }
    if (a.summary && a.status === 'done') f.el.title = a.summary;
  }

  // Reorder the pane as a tree: roots in spawn order, each followed
  // depth-first by its children. Called only when the agent set changes so
  // frames keep patching in place across normal ticks.
  function resortFrames(list) {
    var kids = {}, roots = [], known = {}, i;
    for (i = 0; i < list.length; i++) known[list[i].name] = true;
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.parent !== null && known[a.parent]) {
        if (!kids[a.parent]) kids[a.parent] = [];
        kids[a.parent].push(a);
      } else {
        roots.push(a);
      }
    }
    var walk = function (node, depth) {
      var f = frames[node.name];
      if (f) {
        var indent = Math.min(depth, 4) * 14;   // cap so deep chains stay readable
        f.wrap.style.marginLeft = indent + 'px';
        f.veinEl.style.display = depth > 0 ? '' : 'none';
        if (f.spawned) f.el.style.animation = 'none';  // don't replay spawn skitter on reorder
        framesEl.appendChild(f.wrap);
        f.spawned = true;
      }
      var c = kids[node.name] || [];
      for (var j = 0; j < c.length; j++) walk(c[j], depth + 1);
    };
    for (i = 0; i < roots.length; i++) walk(roots[i], 0);
  }

  function renderAgents(list) {
    $('broodEmpty').style.display = list.length === 0 ? '' : 'none';
    var sig = '';
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      agentsByName[a.name] = a;
      var f = frames[a.name];
      if (!f) { f = makeFrame(a); frames[a.name] = f; }
      patchFrame(f, a);
      sig += a.name + '>' + (a.parent === null ? '' : a.parent) + '|';
    }
    if (sig !== treeSig) {
      treeSig = sig;
      resortFrames(list);
    }
    // keep an open hover card fresh across ticks
    if (cardAgent !== null && agentsByName[cardAgent]) buildCard(cardAgent);
  }

  function flashFrame(name) {
    var f = frames[name];
    if (!f) return;
    f.el.classList.remove('flash');
    void f.el.offsetWidth;             // restart animation
    f.el.classList.add('flash');
    setTimeout(function () { f.el.classList.remove('flash'); }, 550);
  }

  // ---------- agent inspection: hover card + feed spotlight + pin filter ----------
  var hovercard = $('hovercard');
  var agentchip = $('agentchip');

  function fmtAgo(ts) {
    if (!ts) return '';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  function lineageOf(a) {
    var chain = [a.name];
    var cur = a.parent, guard = 0;
    while (cur && guard++ < 20) {
      chain.unshift(cur);
      var p = agentsByName[cur];
      cur = p ? p.parent : null;
    }
    return chain.length === 1 ? 'root' : chain.join(' \\u2192 ');
  }

  function hcLine(key, val) {
    var row = document.createElement('div'); row.className = 'hc-line';
    var k = document.createElement('span'); k.className = 'hc-key'; k.textContent = key;
    row.appendChild(k);
    if (val !== null) {
      var v = document.createElement('span'); v.className = 'hc-val'; v.textContent = val;
      row.appendChild(v);
    }
    hovercard.appendChild(row);
    return row;
  }

  function buildCard(name) {
    var a = agentsByName[name];
    if (!a) { hideCard(); return; }
    hovercard.className = 'st-' + a.status;   // lets .fstatus color rules apply
    hovercard.textContent = '';

    var head = document.createElement('div'); head.className = 'hc-head';
    var nm = document.createElement('span'); nm.className = 'hc-name'; nm.textContent = a.name;
    var st = document.createElement('span'); st.className = 'fstatus'; st.textContent = statusLabel(a.status);
    head.appendChild(nm); head.appendChild(st);
    if (a.adapter) {
      var ad = document.createElement('span'); ad.className = 'fadapter'; ad.textContent = a.adapter; ad.title = a.adapter;
      head.appendChild(ad);
    }
    if (a.tier) {
      var tc = document.createElement('span'); tc.className = 'ftier tier-' + a.tier; tc.textContent = a.tier;
      head.appendChild(tc);
    }
    hovercard.appendChild(head);

    var role = document.createElement('div'); role.className = 'hc-role'; role.textContent = a.role;
    hovercard.appendChild(role);

    hcLine('lineage', lineageOf(a));
    hcLine('turns', a.turns + ' \\u00b7 ' + a.pendingWakes + ' pending wake' + (a.pendingWakes === 1 ? '' : 's'));

    var actRow = hcLine('activity', null);
    var ago = document.createElement('span'); ago.className = 'hc-ago'; ago.textContent = fmtAgo(a.lastActivityAt);
    actRow.appendChild(ago);
    var actBody = document.createElement('div'); actBody.className = 'hc-body'; actBody.textContent = a.lastActivity;
    hovercard.appendChild(actBody);

    if (a.summary && a.status === 'done') {
      hcLine('summary', null);
      var sum = document.createElement('div'); sum.className = 'hc-body'; sum.textContent = a.summary;
      hovercard.appendChild(sum);
    }

    hcLine('recent', null);
    var evts = eventsByAgent[name] || [];
    if (evts.length === 0) {
      var none = document.createElement('div'); none.className = 'hc-evt';
      var nspan = document.createElement('span'); nspan.className = 'hc-none'; nspan.textContent = 'no events yet';
      none.appendChild(nspan);
      hovercard.appendChild(none);
    }
    for (var i = evts.length - 1, n = 0; i >= 0 && n < 5; i--, n++) {
      var e = evts[i];
      var row = document.createElement('div'); row.className = 'hc-evt';
      var id = document.createElement('span'); id.className = 'eid'; id.textContent = '#' + e.id;
      var badge = document.createElement('span'); badge.className = 'badge t-' + e.type; badge.textContent = e.type;
      row.appendChild(id); row.appendChild(badge);
      if (e.channel) {
        var ch = document.createElement('span'); ch.className = 'echan'; ch.textContent = '#' + e.channel;
        row.appendChild(ch);
      }
      var excerpt = e.body.replace(/\\s+/g, ' ').slice(0, 60);
      if (e.body.length > 60) excerpt += '\\u2026';
      var eb = document.createElement('span'); eb.className = 'hc-ebody'; eb.textContent = excerpt; eb.title = e.body;
      row.appendChild(eb);
      hovercard.appendChild(row);
    }
  }

  function showCard(name, frameEl) {
    cardAgent = name;
    buildCard(name);
    if (cardAgent === null) return;          // buildCard bailed
    hovercard.style.display = 'block';
    var r = frameEl.getBoundingClientRect();
    var cw = hovercard.offsetWidth, chh = hovercard.offsetHeight;
    var left = r.right + 10;
    if (left + cw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - cw - 8);
    var top = r.top;
    if (top + chh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - chh - 8);
    hovercard.style.left = left + 'px';
    hovercard.style.top = top + 'px';
  }

  function hideCard() {
    cardAgent = null;
    hovercard.style.display = 'none';
  }

  function setSpotlight(name) {
    spotAgent = name;
    var rows = feed.children;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.classList.contains('evt')) continue;
      if (r.dataset.agent === name) { r.classList.add('spot-on'); r.classList.remove('spot-dim'); }
      else { r.classList.add('spot-dim'); r.classList.remove('spot-on'); }
    }
  }

  function clearSpotlight() {
    spotAgent = null;
    var rows = feed.children;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.classList.contains('evt')) { r.classList.remove('spot-dim'); r.classList.remove('spot-on'); }
    }
  }

  function scheduleHide() {
    if (hoverHideTimer !== null) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(function () {
      hoverHideTimer = null;
      if (cardHover) return;                 // grace: mouse made it onto the card
      hideCard();
      clearSpotlight();
    }, 220);
  }

  // brighten the veins along an agent's ancestor chain
  function litLineage(name, on) {
    var cur = name, guard = 0;
    while (cur !== null && guard++ < 30) {
      var f = frames[cur];
      if (f) f.veinEl.classList.toggle('lit', on);
      var a = agentsByName[cur];
      cur = a ? a.parent : null;
    }
  }

  function frameEnter(name, el) {
    if (hoverHideTimer !== null) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
    if (hoverShowTimer !== null) clearTimeout(hoverShowTimer);
    if (litAgent !== null && litAgent !== name) litLineage(litAgent, false);
    litAgent = name;
    litLineage(name, true);
    setSpotlight(name);
    hoverShowTimer = setTimeout(function () {
      hoverShowTimer = null;
      showCard(name, el);
    }, 150);
  }

  function frameLeave() {
    if (hoverShowTimer !== null) { clearTimeout(hoverShowTimer); hoverShowTimer = null; }
    if (litAgent !== null) { litLineage(litAgent, false); litAgent = null; }
    scheduleHide();
  }

  hovercard.addEventListener('mouseenter', function () {
    cardHover = true;
    if (hoverHideTimer !== null) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  });
  hovercard.addEventListener('mouseleave', function () {
    cardHover = false;
    scheduleHide();
  });

  function setAgentFilter(name) {
    agentFilter = name;
    for (var n in frames) {
      if (frames.hasOwnProperty(n)) frames[n].el.classList.toggle('selected', n === name);
    }
    if (name === null) {
      agentchip.style.display = 'none';
    } else {
      agentchip.style.display = 'inline-block';
      agentchip.textContent = 'agent: ' + name + ' \\u2715';
    }
    applyFilter();
  }

  function toggleAgentFilter(name) {
    setAgentFilter(agentFilter === name ? null : name);
  }

  agentchip.onclick = function () { setAgentFilter(null); };

  // ---------- channel tabs ----------
  function renderTabs(channels) {
    var sig = channels.map(function (c) { return c.name + ':' + c.eventCount; }).join('|');
    if (sig === channelSig) return;
    channelSig = sig;
    var tabs = $('tabs');
    tabs.textContent = '';
    var mk = function (label, count, key) {
      var b = document.createElement('button');
      b.className = 'tab' + (activeChannel === key ? ' active' : '');
      b.textContent = label;
      if (count !== null) {
        var c = document.createElement('span'); c.className = 'cnt'; c.textContent = String(count);
        b.appendChild(c);
      }
      b.onclick = function () { activeChannel = key; channelSig = ''; renderTabs(channels); applyFilter(); };
      tabs.appendChild(b);
    };
    mk('All', null, null);
    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      mk('#' + ch.name, ch.eventCount, ch.name);
    }
  }

  // ---------- pins ----------
  function renderPins(pins) {
    var strip = $('pinstrip');
    strip.className = pins.length > 0 ? 'haspins' : '';
    strip.textContent = '';
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i];
      var chip = document.createElement('span');
      chip.className = 'pinchip';
      var evt = eventsById[p.eventId];
      var excerpt = evt ? evt.body.replace(/\\s+/g, ' ').slice(0, 90) : '';
      chip.textContent = '\\ud83d\\udccc #' + p.eventId + (excerpt ? ' ' + excerpt : '') + ' ';
      var by = document.createElement('span'); by.className = 'by'; by.textContent = '(' + p.agent + ')';
      chip.appendChild(by);
      if (evt) chip.title = evt.body;
      strip.appendChild(chip);
    }
  }

  // ---------- feed ----------
  function rowMatches(row) {
    if (activeChannel !== null && row.dataset.channel !== activeChannel) return false;
    if (agentFilter !== null && row.dataset.agent !== agentFilter) return false;
    if (filterText !== '' && row.dataset.search.indexOf(filterText) === -1) return false;
    return true;
  }

  function applyFilter() {
    var rows = feed.children;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.classList.contains('evt')) r.style.display = rowMatches(r) ? '' : 'none';
    }
    maybeScroll();
  }

  function appendEvent(evt) {
    if (evt.id <= lastSeenId) return;
    lastSeenId = evt.id;
    eventsById[evt.id] = evt;
    var recent = eventsByAgent[evt.agent] || (eventsByAgent[evt.agent] = []);
    recent.push(evt);
    if (recent.length > 12) recent.shift();
    $('feedEmpty').style.display = 'none';

    var row = document.createElement('div');
    row.className = 'evt';
    if (spotAgent !== null) row.className += evt.agent === spotAgent ? ' spot-on' : ' spot-dim';
    row.dataset.channel = evt.channel || '';
    row.dataset.agent = evt.agent;
    row.dataset.search = (evt.agent + ' ' + evt.type + ' ' + (evt.channel || '') + ' ' + evt.body + ' ' + evt.tags.join(' ')).toLowerCase();

    var id = document.createElement('span'); id.className = 'eid'; id.textContent = '#' + evt.id;
    var badge = document.createElement('span'); badge.className = 'badge t-' + evt.type; badge.textContent = evt.type; badge.title = evt.type;
    var ag = document.createElement('span'); ag.className = 'eagent'; ag.textContent = evt.agent; ag.title = evt.agent;
    var ch = document.createElement('span'); ch.className = 'echan';
    ch.textContent = evt.channel ? '#' + evt.channel : '';
    if (evt.channel) ch.title = '#' + evt.channel;
    var body = document.createElement('div'); body.className = 'ebody'; body.textContent = evt.body;
    body.title = 'click to expand';
    body.onclick = function () { body.classList.toggle('open'); };
    if (evt.duplicateOf !== null) {
      var dup = document.createElement('span'); dup.className = 'duplink';
      dup.textContent = ' \\u21a9 dup of #' + evt.duplicateOf;
      body.appendChild(dup);
    }

    row.appendChild(id); row.appendChild(badge); row.appendChild(ag); row.appendChild(ch); row.appendChild(body);
    if (!rowMatches(row)) row.style.display = 'none';
    feed.appendChild(row);

    // keep the DOM bounded
    while (feed.children.length > MAX_ROWS + 1) {
      var first = feed.children[1]; // children[0] is the empty-state div
      if (!first) break;
      feed.removeChild(first);
    }

    flashFrame(evt.agent);
  }

  function maybeScroll() {
    if (following && !feedHover) feed.scrollTop = feed.scrollHeight;
  }

  // ---------- state merge ----------
  function applyState(state) {
    lastState = state;
    renderVitals(state.snapshot);
    renderAgents(state.snapshot.agents);
    renderTabs(state.channels);
    renderPins(state.pins);
    updateDirectLine(state.snapshot.agents);
  }

  // ---------- data plumbing ----------
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
      return r.json();
    });
  }

  function fetchMissed() {
    return fetchJSON(apiBase + '/api/events?since_id=' + lastSeenId + '&limit=500').then(function (evts) {
      for (var i = 0; i < evts.length; i++) appendEvent(evts[i]);
      if (evts.length === 500) return fetchMissed();  // page through a big gap
      maybeScroll();
    });
  }

  function openStream() {
    if (es) { es.close(); es = null; }
    es = new EventSource(apiBase + '/api/stream?since_id=' + lastSeenId);
    es.addEventListener('tick', function (msg) {
      reconnects = 0;
      setConn('live');
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      applyState(data.state);
      for (var i = 0; i < data.events.length; i++) appendEvent(data.events[i]);
      if (data.events.length > 0) { renderPins(data.state.pins); maybeScroll(); }
    });
    es.onopen = function () { setConn('live'); };
    es.onerror = function () {
      setConn('recon');
      if (es) { es.close(); es = null; }
      var delay = Math.min(400 * Math.pow(2, reconnects++), 10000);
      setTimeout(function () {
        fetchJSON(apiBase + '/api/state')
          .then(function (state) { applyState(state); return fetchMissed(); })
          .then(function () { openStream(); })
          .catch(function () { es = null; setConn('recon'); openStream_retry(); });
      }, delay);
    };
  }

  function openStream_retry() {
    var delay = Math.min(400 * Math.pow(2, reconnects++), 10000);
    setTimeout(openStream, delay);
  }

  // ---------- controls ----------
  $('followbtn').onclick = function () {
    following = !following;
    this.className = following ? 'on' : '';
    this.textContent = following ? 'FOLLOWING' : 'PAUSED';
    maybeScroll();
  };
  feed.addEventListener('mouseenter', function () { feedHover = true; });
  feed.addEventListener('mouseleave', function () { feedHover = false; maybeScroll(); });
  $('filter').addEventListener('input', function () {
    filterText = this.value.trim().toLowerCase();
    applyFilter();
  });

  // ---------- settings drawer ----------
  var drawer = $('drawer');
  var drawerOpen = false;
  var msgTimers = {};              // msg element id -> timeout handle
  var TIER_NAMES = ['heavy', 'standard', 'light'];

  function secMsg(el, text, isErr) {
    var k = el.id;
    if (msgTimers[k]) { clearTimeout(msgTimers[k]); delete msgTimers[k]; }
    el.textContent = text;
    el.title = text;
    el.className = 'secmsg' + (text === '' ? '' : (isErr ? ' err' : ' ok'));
    if (text !== '' && !isErr) {
      msgTimers[k] = setTimeout(function () {
        delete msgTimers[k];
        el.textContent = '';
        el.className = 'secmsg';
      }, 1600);
    }
  }

  function postConfig(payload, msgEl, onOk) {
    fetch(apiBase + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (!res.ok || (res.j && res.j.error)) {
        secMsg(msgEl, (res.j && res.j.error) || 'request failed', true);
        return;
      }
      secMsg(msgEl, 'applied', false);
      if (onOk) onOk(res.j);
    }).catch(function () {
      secMsg(msgEl, 'request failed', true);
    });
  }

  // ----- limits: sliders with an infinity escape hatch (null = unlimited) -----
  function limitReadout(slider, valEl, box) {
    valEl.textContent = box.checked ? INF : String(slider.value);
  }

  function wireLimit(sliderId) {
    var slider = $(sliderId), valEl = $(sliderId + '-val'), box = $(sliderId + '-inf');
    slider.addEventListener('input', function () { limitReadout(slider, valEl, box); });
    box.addEventListener('change', function () {
      slider.disabled = box.checked;
      limitReadout(slider, valEl, box);
    });
  }
  wireLimit('cfg-maxturns');
  wireLimit('cfg-maxagents');

  function fillLimit(sliderId, value) {
    var slider = $(sliderId), valEl = $(sliderId + '-val'), box = $(sliderId + '-inf');
    var isNull = value === null || value === undefined;
    box.checked = isNull;
    slider.disabled = isNull;
    if (!isNull) slider.value = value;
    limitReadout(slider, valEl, box);
  }

  $('apply-limits').onclick = function () {
    var payload = {
      maxTotalTurns: $('cfg-maxturns-inf').checked ? null : Number($('cfg-maxturns').value),
      maxAgents: $('cfg-maxagents-inf').checked ? null : Number($('cfg-maxagents').value),
    };
    postConfig(payload, $('msg-limits'), function (res) {
      fillLimit('cfg-maxturns', res.maxTotalTurns);
      fillLimit('cfg-maxagents', res.maxAgents);
      // reflect new limits in the header vitals denominators right away
      if (lastState) {
        lastState.snapshot.maxTotalTurns = res.maxTotalTurns;
        lastState.snapshot.maxAgents = res.maxAgents;
        renderVitals(lastState.snapshot);
      }
    });
  };

  // ----- tiers: adapter per tier + sampling weights -----
  function fillTierSelect(sel, adapters, current) {
    sel.textContent = '';
    var unset = document.createElement('option');
    unset.value = ''; unset.textContent = '(unset)';
    sel.appendChild(unset);
    var seen = false;
    for (var i = 0; i < adapters.length; i++) {
      var o = document.createElement('option');
      o.value = adapters[i]; o.textContent = adapters[i];
      sel.appendChild(o);
      if (adapters[i] === current) seen = true;
    }
    if (current && !seen) {
      var extra = document.createElement('option');
      extra.value = current; extra.textContent = current;
      sel.appendChild(extra);
    }
    sel.value = current || '';
  }

  function fillTiers(cfg) {
    var adapters = cfg.availableAdapters || [];
    var tiers = cfg.tiers || {};
    var weights = cfg.tierWeights || {};
    for (var i = 0; i < TIER_NAMES.length; i++) {
      var t = TIER_NAMES[i];
      fillTierSelect($('cfg-tier-' + t), adapters, tiers[t] || null);
      var w = weights[t];
      $('cfg-w-' + t).value = (w === null || w === undefined) ? '' : w;
    }
  }

  $('apply-tiers').onclick = function () {
    var tiers = {}, weights = {}, anyWeight = false;
    for (var i = 0; i < TIER_NAMES.length; i++) {
      var t = TIER_NAMES[i];
      tiers[t] = $('cfg-tier-' + t).value || null;
      var raw = $('cfg-w-' + t).value.trim();
      if (raw !== '') { weights[t] = Number(raw); anyWeight = true; }
    }
    var payload = { tiers: tiers };
    if (anyWeight) payload.tierWeights = weights;
    postConfig(payload, $('msg-tiers'), function (res) { fillTiers(res); });
  };

  // ----- pacing: turn delay + the big pause lever -----
  function delayReadout() {
    $('cfg-delay-val').textContent = (Number($('cfg-delay').value) / 1000) + 's';
  }
  $('cfg-delay').addEventListener('input', delayReadout);

  function setPauseUI() {
    var b = $('pausebtn');
    b.textContent = isPaused ? 'RESUME' : 'PAUSE';
    b.className = isPaused ? 'paused' : '';
    renderConn();
  }

  $('pausebtn').onclick = function () {
    // pause is immediate: no Apply between the overseer and the brakes
    postConfig({ paused: !isPaused }, $('msg-pacing'), function (res) {
      isPaused = !!res.paused;
      setPauseUI();
    });
  };

  $('apply-pacing').onclick = function () {
    postConfig({ turnDelayMs: Number($('cfg-delay').value) }, $('msg-pacing'), function (res) {
      $('cfg-delay').value = res.turnDelayMs;
      delayReadout();
    });
  };

  // ----- board -----
  $('apply-board').onclick = function () {
    var payload = {
      pinSlots: Number($('cfg-pinslots').value),
      claimTtlMs: Number($('cfg-ttl').value),
    };
    postConfig(payload, $('msg-board'), function (res) {
      $('cfg-pinslots').value = res.pinSlots;
      $('cfg-ttl').value = res.claimTtlMs;
    });
  };

  // ----- protocol appendix -----
  $('apply-protocol').onclick = function () {
    postConfig({ protocolAppendix: $('cfg-appendix').value }, $('msg-protocol'), function (res) {
      $('cfg-appendix').value = res.protocolAppendix || '';
    });
  };

  function fillConfig(cfg) {
    $('cfg-adapter').textContent = cfg.adapter;
    $('cfg-root').textContent = cfg.rootName;
    $('cfg-prompt').textContent = cfg.rootPrompt;
    $('cfg-protocol').textContent = cfg.protocol;
    fillLimit('cfg-maxturns', cfg.maxTotalTurns);
    fillLimit('cfg-maxagents', cfg.maxAgents);
    fillTiers(cfg);
    $('cfg-delay').value = cfg.turnDelayMs || 0;
    delayReadout();
    isPaused = !!cfg.paused;
    setPauseUI();
    $('cfg-pinslots').value = cfg.pinSlots;
    $('cfg-ttl').value = cfg.claimTtlMs;
    $('cfg-appendix').value = cfg.protocolAppendix || '';
  }

  function loadConfig() {
    fetchJSON(apiBase + '/api/config').then(fillConfig).catch(function () {
      secMsg($('msg-limits'), 'failed to load config', true);
    });
  }

  function openDrawer() {
    drawerOpen = true;
    drawer.classList.add('open');
    loadConfig();
  }

  function closeDrawer() {
    drawerOpen = false;
    drawer.classList.remove('open');
  }

  $('gearbtn').onclick = function () { if (drawerOpen) closeDrawer(); else openDrawer(); };
  $('drawerclose').onclick = closeDrawer;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (drawerOpen) { closeDrawer(); return; }
    if (agentFilter !== null) setAgentFilter(null);
  });

  // ---------- direct line: console seam to the overseer ----------
  var dlSig = '';
  var dlErrTimer = null;

  // foldable console: default collapsed, open/closed remembered per browser
  var DL_KEY = 'swarmlord-dl-open';
  var dlOpen = false;
  try { dlOpen = localStorage.getItem(DL_KEY) === '1'; } catch (e) { /* private mode etc. */ }

  function setDlOpen(open) {
    dlOpen = open;
    $('directline').classList.toggle('open', open);
    try { localStorage.setItem(DL_KEY, open ? '1' : '0'); } catch (e) { /* best effort */ }
  }
  setDlOpen(dlOpen);
  $('dl-head').onclick = function () { setDlOpen(!dlOpen); };

  function updateDirectLine(list) {
    var live = [], rootLive = null, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].status === 'done') continue;
      live.push(list[i].name);
      if (rootLive === null && list[i].parent === null) rootLive = list[i].name;
    }
    var sig = live.join('|');
    if (sig === dlSig) return;
    dlSig = sig;
    var sel = $('dl-agent');
    var prev = sel.value;
    sel.textContent = '';
    for (i = 0; i < live.length; i++) {
      var o = document.createElement('option');
      o.value = live[i]; o.textContent = live[i];
      sel.appendChild(o);
    }
    if (live.indexOf(prev) !== -1) sel.value = prev;
    else if (rootLive !== null) sel.value = rootLive;
    else if (live.length > 0) sel.value = live[0];
  }

  function dlError(text) {
    var el = $('dl-err');
    el.textContent = text;
    el.style.display = 'block';
    if (dlErrTimer !== null) clearTimeout(dlErrTimer);
    dlErrTimer = setTimeout(function () {
      dlErrTimer = null;
      el.style.display = 'none';
    }, 3500);
  }

  function dlSend() {
    var agent = $('dl-agent').value;
    var text = $('dl-text').value.trim();
    if (agent === '' || text === '') return;
    fetch(apiBase + '/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agent, text: text }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (!res.ok || (res.j && res.j.error)) {
        dlError((res.j && res.j.error) || 'send failed');
        return;
      }
      $('dl-text').value = '';
      flashFrame(agent);
    }).catch(function () {
      dlError('send failed');
    });
  }

  $('dl-send').onclick = dlSend;
  $('dl-text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') dlSend();
  });

  // ---------- boot ----------
  function boot() {
    setConn('connecting');
    Promise.all([
      fetchJSON(apiBase + '/api/state'),
      fetchJSON(apiBase + '/api/events?since_id=0&limit=500'),
    ]).then(function (res) {
      var state = res[0], events = res[1];
      for (var i = 0; i < events.length; i++) appendEvent(events[i]);
      applyState(state);
      maybeScroll();
      openStream();
      loadConfig();   // prefill the drawer + surface paused state in the header
    }).catch(function () {
      setConn('recon');
      setTimeout(boot, 1200);
    });
  }

  // ---------- hive mode: tiny hash router over the same single page ----------
  // The page probes GET /api/swarms once. 404 means a single-swarm server:
  // boot the dashboard against base ''. 200 means a hive: #/ is the home
  // screen, #/s/<id> is the dashboard against base '/s/<id>'. Navigation
  // reloads the page so every view boots from a clean slate.
  var hiveMode = false;
  var hiveSig = '';
  var hiveMsgTimer = null;

  function parseRoute() {
    var h = location.hash;
    if (h.indexOf('#/s/') === 0) {
      var id = h.slice(4);
      var cut = id.indexOf('?');
      if (cut !== -1) id = id.slice(0, cut);
      if (id !== '') return { view: 'swarm', id: decodeURIComponent(id) };
    }
    return { view: 'home' };
  }

  function enterSwarm(base, title) {
    apiBase = base;
    if (hiveMode) {
      $('hivelink').style.display = '';
      if (title) {
        var t = $('swarmtitle');
        t.style.display = '';
        t.textContent = title;
        t.title = title;
      }
    }
    boot();
  }

  function enterHome(list) {
    $('brood').style.display = 'none';
    $('boardcol').style.display = 'none';
    $('gearbtn').style.display = 'none';
    $('connbox').style.display = 'none';
    $('dashvitals').style.display = 'none';
    $('hivevitals').style.display = 'flex';
    $('hivehome').style.display = '';
    renderHive(list);
    setInterval(pollHive, 2000);
  }

  function pollHive() {
    fetchJSON('/api/swarms').then(renderHive).catch(function () {});
  }

  function hiveMsg(text) {
    var el = $('hive-msg');
    el.textContent = text;
    if (hiveMsgTimer !== null) clearTimeout(hiveMsgTimer);
    hiveMsgTimer = setTimeout(function () {
      hiveMsgTimer = null;
      el.textContent = '';
    }, 4000);
  }

  function hiveAction(path, method) {
    fetch(path, { method: method }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (j) {
        if (!r.ok || (j && j.error)) throw new Error((j && j.error) || 'HTTP ' + r.status);
        return j;
      });
    }).then(function () {
      hiveSig = '';                      // force a list rebuild on next render
      pollHive();
    }).catch(function (e) {
      hiveMsg(e && e.message ? e.message : 'request failed');
      pollHive();
    });
  }

  function openSwarm(id) { location.hash = '#/s/' + encodeURIComponent(id); }

  function swarmCard(rec) {
    var card = document.createElement('div');
    card.className = 'plate swplate' +
      (rec.running ? ' running' : '') +
      (rec.status === 'archived' ? ' archived' : '') +
      (rec.error ? ' errored' : '');

    var head = document.createElement('div'); head.className = 'swhead';
    var title = document.createElement('span'); title.className = 'swtitle'; title.textContent = rec.title; title.title = rec.title;
    var idEl = document.createElement('span'); idEl.className = 'swid'; idEl.textContent = rec.id;
    var chip = document.createElement('span'); chip.className = 'chip ' + rec.status; chip.textContent = rec.status;
    head.appendChild(title); head.appendChild(idEl); head.appendChild(chip);
    if (rec.running) {
      var run = document.createElement('span'); run.className = 'runind';
      run.appendChild(document.createElement('i'));
      run.appendChild(document.createTextNode('RUNNING'));
      head.appendChild(run);
    }
    var dt = document.createElement('span'); dt.className = 'swdate';
    dt.textContent = new Date(rec.createdAt).toLocaleString();
    head.appendChild(dt);
    card.appendChild(head);

    if (rec.task) {
      var task = document.createElement('div'); task.className = 'swtask';
      var excerpt = rec.task.replace(/\\s+/g, ' ');
      if (excerpt.length > 160) excerpt = excerpt.slice(0, 160) + '\\u2026';
      task.textContent = excerpt;
      task.title = rec.task;
      card.appendChild(task);
    }

    if (rec.error) {
      var err = document.createElement('div'); err.className = 'swerr'; err.textContent = rec.error;
      card.appendChild(err);
    } else if (rec.result) {
      var stats = document.createElement('div'); stats.className = 'swstats';
      var addStat = function (n, label, first) {
        if (!first) stats.appendChild(document.createTextNode(' \\u00b7 '));
        var b = document.createElement('b'); b.textContent = String(n);
        stats.appendChild(b);
        stats.appendChild(document.createTextNode(' ' + label));
      };
      addStat(rec.result.turns, 'turns', true);
      addStat(rec.result.agents, 'agents', false);
      addStat(rec.result.events, 'events', false);
      card.appendChild(stats);
    }

    var btns = document.createElement('div'); btns.className = 'swbtns';
    var mkBtn = function (label, cls, fn) {
      var b = document.createElement('button');
      b.className = 'swbtn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.onclick = function (e) { e.stopPropagation(); fn(); };
      btns.appendChild(b);
    };
    var api = '/api/swarms/' + encodeURIComponent(rec.id);
    mkBtn('open', '', function () { openSwarm(rec.id); });
    if (rec.running) {
      mkBtn('stop', 'danger', function () {
        if (confirm('soft-stop swarm "' + rec.title + '"?')) hiveAction(api + '/stop', 'POST');
      });
    }
    if (rec.status === 'archived') {
      mkBtn('unarchive', '', function () { hiveAction(api + '/unarchive', 'POST'); });
    } else {
      mkBtn('archive', '', function () { hiveAction(api + '/archive', 'POST'); });
    }
    if (!rec.running) {
      mkBtn('delete', 'danger', function () {
        if (confirm('delete swarm "' + rec.title + '" and its event log? this cannot be undone.')) {
          hiveAction(api, 'DELETE');
        }
      });
    }
    card.appendChild(btns);
    card.onclick = function () { openSwarm(rec.id); };
    return card;
  }

  function renderHive(list) {
    var running = 0, archived = 0, i;
    for (i = 0; i < list.length; i++) {
      if (list[i].running) running++;
      if (list[i].status === 'archived') archived++;
    }
    $('hv-total').textContent = String(list.length);
    $('hv-running').textContent = String(running);
    $('hv-archived').textContent = String(archived);
    var sig = JSON.stringify(list);
    if (sig === hiveSig) return;
    hiveSig = sig;
    $('hiveEmpty').style.display = list.length === 0 ? '' : 'none';
    var wrap = $('swarmlist');
    wrap.textContent = '';
    for (i = 0; i < list.length; i++) wrap.appendChild(swarmCard(list[i]));
  }

  $('ns-launch').onclick = function () {
    var title = $('ns-title').value.trim();
    var task = $('ns-task').value.trim();
    if (task === '') { secMsg($('ns-msg'), 'task is required', true); return; }
    var btn = this;
    btn.disabled = true;
    fetch('/api/swarms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, task: task }),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      btn.disabled = false;
      if (!res.ok || (res.j && res.j.error)) {
        secMsg($('ns-msg'), (res.j && res.j.error) || 'launch failed', true);
        return;
      }
      openSwarm(res.j.id);
    }).catch(function () {
      btn.disabled = false;
      secMsg($('ns-msg'), 'launch failed', true);
    });
  };

  // every navigation reboots the page so the dashboard state never bleeds
  // between swarms (and home tears down its poller for free)
  window.addEventListener('hashchange', function () { location.reload(); });

  function start() {
    setConn('connecting');
    fetch('/api/swarms').then(function (r) {
      if (r.status === 404) return null;                 // single-swarm server
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (list) {
      if (list === null) { enterSwarm('', null); return; }
      hiveMode = true;
      var route = parseRoute();
      if (route.view === 'swarm') {
        var title = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].id === route.id) { title = list[i].title; break; }
        }
        enterSwarm('/s/' + encodeURIComponent(route.id), title || route.id);
      } else {
        enterHome(list);
      }
    }).catch(function () {
      setConn('recon');
      setTimeout(start, 1200);
    });
  }

  start();
})();
</script>
</body>
</html>
`
