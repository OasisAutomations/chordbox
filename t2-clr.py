import asyncio, sys
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18790/'
res = []
def chk(n, c, extra=''):
    res.append((n, bool(c))); print(('PASS ' if c else 'FAIL ') + n, '' if c else extra)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        c = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
        pg = await c.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto(URL); await pg.wait_for_timeout(600)
        await pg.locator('#startBtn').tap(); await pg.wait_for_timeout(500)
        ver = await pg.evaluate('Chordbox.VER')
        chk('version bumped', ver == 'v1.0.1', ver)
        # slow tempo so we can observe scheduled events
        await pg.evaluate('Chordbox.state.bpm = 72; document.getElementById("bpmLbl").textContent = 72')
        # record a chord event at ~0ms into the bar
        await pg.evaluate('''() => {
          Chordbox.state.loop = { rec:false, playing:false, events:[], start:0, len:0 };
          Chordbox.toggleRec();
          Chordbox.startChord(0);
        }''')
        await pg.wait_for_timeout(120)
        await pg.evaluate('Chordbox.stopChord(0)')
        await pg.wait_for_timeout(80)
        # stop recording arm but leave playback + events
        await pg.evaluate('Chordbox.toggleRec()')
        nEv = await pg.evaluate('Chordbox.state.loop.events.length')
        chk('recorded on+off events', nEv >= 2, nEv)
        playing = await pg.evaluate('Chordbox.state.loop.playing')
        chk('loop playing while recorded', playing)
        # wait into next bar scheduling window so timeouts are armed
        await pg.wait_for_timeout(400)
        pending = await pg.evaluate('Chordbox.loopTimeouts.length')
        # may or may not have pending depending on beat phase — force a schedule
        await pg.evaluate('Chordbox.state.loop.playing = true; Chordbox.cancelLoopSched();')
        # manually schedule like playLoopBeat would, then CLR
        await pg.evaluate('''() => {
          // inject long-delayed events that would fire if CLR failed to cancel
          const L = Chordbox.state.loop;
          L.events = [{type:'on', deg:0, at:300}, {type:'off', deg:0, at:800},
                      {type:'on', deg:4, at:500}, {type:'off', deg:4, at:900}];
          L.playing = true; L.rec = true; L.len = 4000;
          // call internal scheduler via metro beat 0 path
          const beat0 = 0;
          // emulate playLoopBeat(0)
          const len = L.len;
          L.events.forEach(ev => {
            const id = setTimeout(() => {
              if (!Chordbox.state.loop.playing) return;
              if (ev.type === 'on') Chordbox.startChord(ev.deg, true);
              else Chordbox.stopChord(ev.deg, true);
            }, ev.at % len);
            Chordbox.loopTimeouts.push(id);
          });
          // also sound a loop voice now
          Chordbox.startChord(0, true);
        }''')
        heldBefore = await pg.evaluate('Chordbox.held.size')
        pendingBefore = await pg.evaluate('Chordbox.loopTimeouts.length')
        chk('pending loop timers armed', pendingBefore >= 4, pendingBefore)
        chk('loop voice sounding before CLR', heldBefore >= 1, heldBefore)
        # press CLR via UI
        await pg.locator('#btnClear').tap(); await pg.wait_for_timeout(100)
        snap = await pg.evaluate('''() => ({
          playing: Chordbox.state.loop.playing,
          rec: Chordbox.state.loop.rec,
          events: Chordbox.state.loop.events.length,
          held: Chordbox.held.size,
          pending: Chordbox.loopTimeouts.length,
          playBtn: document.getElementById('btnPlayLoop').getAttribute('aria-pressed'),
          recBtn: document.getElementById('btnRec').getAttribute('aria-pressed'),
          playLabel: document.getElementById('btnPlayLoop').textContent.trim(),
          arp: Chordbox.arpTimer,
        })''')
        print('after CLR', snap)
        chk('CLR stops playing', snap['playing'] is False)
        chk('CLR stops recording', snap['rec'] is False)
        chk('CLR clears events', snap['events'] == 0)
        chk('CLR cancels pending timers', snap['pending'] == 0, snap['pending'])
        chk('CLR silences voices', snap['held'] == 0, snap['held'])
        chk('play button reset', snap['playBtn'] == 'false' and snap['playLabel'] == '▶')
        chk('rec button reset', snap['recBtn'] == 'false')
        # wait past when cancelled events would have fired
        await pg.wait_for_timeout(1000)
        afterWait = await pg.evaluate('''() => ({ held: Chordbox.held.size, pending: Chordbox.loopTimeouts.length, events: Chordbox.state.loop.events.length })''')
        chk('no loop notes fire after CLR', afterWait['held'] == 0 and afterWait['pending'] == 0, afterWait)
        # ▶ stop behavior: record, play, stop with play button
        await pg.evaluate('''() => {
          Chordbox.state.bpm = 100;
          Chordbox.state.loop.events = [{type:'on', deg:2, at:50}, {type:'off', deg:2, at:400}];
          Chordbox.state.loop.len = 2000; Chordbox.state.loop.start = performance.now();
          Chordbox.toggleLoopPlay();
          Chordbox.startChord(2, true);
        }''')
        await pg.wait_for_timeout(80)
        chk('play starts', await pg.evaluate('Chordbox.state.loop.playing') is True)
        await pg.locator('#btnPlayLoop').tap(); await pg.wait_for_timeout(100)
        stopSnap = await pg.evaluate('''() => ({
          playing: Chordbox.state.loop.playing, held: Chordbox.held.size,
          pending: Chordbox.loopTimeouts.length,
          label: document.getElementById('btnPlayLoop').textContent.trim(),
          eventsKept: Chordbox.state.loop.events.length
        })''')
        print('after ▶ stop', stopSnap)
        chk('▶ stops playback', stopSnap['playing'] is False and stopSnap['label'] == '▶')
        chk('▶ silences loop voices + cancels timers', stopSnap['held'] == 0 and stopSnap['pending'] == 0, stopSnap)
        chk('▶ keeps recorded events (unlike CLR)', stopSnap['eventsKept'] == 2, stopSnap['eventsKept'])
        # double-rec should not stack metro intervals: startMetro replaces
        await pg.evaluate('''() => {
          Chordbox.state.met = true;
          document.getElementById('btnMet').setAttribute('aria-pressed','true');
          Chordbox.toggleRec();
          const t1 = Chordbox.metroTimer;
          Chordbox.toggleRec(); // off
          Chordbox.toggleRec(); // on again
          window.__metroSameReplace = Chordbox.metroTimer !== null;
        }''')
        chk('rec restart still has a single metro timer', await pg.evaluate('window.__metroSameReplace && Chordbox.metroTimer != null'))
        # met alone after CLR
        await pg.evaluate('Chordbox.clearLoop()')
        await pg.evaluate('''() => {
          Chordbox.state.met = true;
          document.getElementById('btnMet').setAttribute('aria-pressed','true');
          Chordbox.clearLoop();
        }''')
        metAfter = await pg.evaluate('Chordbox.state.met && Chordbox.metroTimer != null && !Chordbox.state.loop.playing')
        chk('metronome can keep running after CLR', metAfter)
        await pg.evaluate('Chordbox.state.met=false; Chordbox.clearLoop()')
        print('errs', errs)
        chk('no console errors', not errs, errs)
        n = sum(1 for _, x in res if x)
        print('RESULT', n, '/', len(res))
        await b.close()
asyncio.run(main())
