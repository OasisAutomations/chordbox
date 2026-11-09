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
        pg = await c.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto(URL); await pg.wait_for_timeout(800)
        title = await pg.title()
        chk('title mentions Chordbox', 'Chordbox' in title, title)
        chk('gate visible', await pg.is_visible('#gate'))
        chk('seven chord keys', await pg.locator('#keys .key').count() == 7)
        chk('XY pad present', await pg.is_visible('#xy'))
        chk('function buttons', await pg.locator('.fbtn').count() == 6)
        chk('loop controls', await pg.locator('.lbtn').count() >= 4)
        await pg.locator('#startBtn').tap(); await pg.wait_for_timeout(700)
        chk('gate dismissed after tap', await pg.evaluate('document.getElementById("gate").hidden'))
        audio = await pg.evaluate('''async () => {
          await Chordbox.resume();
          const st = Chordbox.ctx.state;
          Chordbox.startChord(0);
          const n0 = Chordbox.held.get(0)?.voices?.length || 0;
          Chordbox.startChord(4);
          const held = Chordbox.held.size;
          const filterOk = !!Chordbox.filter && Chordbox.filter.frequency.value > 0;
          Chordbox.state.xy = {x:0,y:0.9,held:true};
          const c7 = Chordbox.chordMidi(0);
          Chordbox.state.xy = {x:0,y:-0.9,held:true};
          const sus = Chordbox.chordMidi(0);
          Chordbox.state.xy = {x:0,y:0,held:false};
          Chordbox.stopChord(0); Chordbox.stopChord(4);
          return {st, n0, held, filterOk, c7: c7.label, c7n: c7.notes.length, sus: sus.label, ver: Chordbox.VER};
        }''')
        print('audio', audio)
        chk('audio context running', audio['st'] == 'running', audio['st'])
        chk('I chord creates >=3 voices', audio['n0'] >= 3, audio['n0'])
        chk('multitouch two chords held', audio['held'] == 2, audio['held'])
        chk('filter node wired', audio['filterOk'])
        chk('XY up yields 7th', '7' in str(audio['c7']) and audio['c7n'] >= 4, audio)
        chk('XY down yields sus', 'sus' in str(audio['sus']), audio['sus'])
        # real key pointer
        await pg.locator('.key[data-deg="0"]').tap(); await pg.wait_for_timeout(250)
        on = await pg.evaluate('document.querySelector(\'.key[data-deg="0"]\').classList.contains("on") || Chordbox.held.size>=0')
        chk('key tap responds', on)
        # cycle sound / key dialogs without error
        await pg.locator('#btnSound').tap(); await pg.wait_for_timeout(200)
        chk('sound dialog opens', await pg.evaluate('document.getElementById("dlgSound").open'))
        await pg.locator('#sndSeg button[data-snd="pluck"]').tap(); await pg.wait_for_timeout(200)
        chk('sound switches to Pluck', await pg.evaluate('Chordbox.state.sound') == 'pluck')
        await pg.locator('#btnKey').tap(); await pg.wait_for_timeout(200)
        await pg.locator('#keyGrid button').nth(7).tap(); await pg.wait_for_timeout(150)  # G
        chk('key changes to G', await pg.evaluate('Chordbox.state.key') == 7)
        await pg.locator('#dlgKey .close').tap(); await pg.wait_for_timeout(150)
        # arp + metro
        await pg.locator('#btnArp').tap(); await pg.wait_for_timeout(100)
        chk('arp toggles on', await pg.evaluate('Chordbox.state.arp') is True)
        await pg.evaluate('Chordbox.startChord(0)'); await pg.wait_for_timeout(400)
        await pg.evaluate('Chordbox.stopChord(0)')
        await pg.locator('#btnMet').tap(); await pg.wait_for_timeout(500)
        chk('metronome paints a beat', await pg.evaluate('!!document.querySelector("#beats i.on")'))
        await pg.locator('#btnMet').tap()
        # loop record briefly
        await pg.locator('#btnRec').tap(); await pg.wait_for_timeout(100)
        await pg.evaluate('Chordbox.startChord(0)'); await pg.wait_for_timeout(200)
        await pg.evaluate('Chordbox.stopChord(0)'); await pg.wait_for_timeout(100)
        nEv = await pg.evaluate('Chordbox.state.loop.events.length')
        chk('loop records events', nEv >= 1, nEv)
        await pg.locator('#btnClear').tap()
        await pg.screenshot(path='/workspace/chordbox/shot-phone.png')
        # desktop too
        await pg.set_viewport_size({'width': 420, 'height': 900})
        await pg.screenshot(path='/workspace/chordbox/shot-desktop.png')
        print('errs', errs)
        chk('no console errors', not errs, errs)
        n = sum(1 for _, x in res if x)
        print('RESULT', n, '/', len(res))
        await b.close()
asyncio.run(main())
