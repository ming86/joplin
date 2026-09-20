"""Actual browser UI against the production gateway/adapter and a synthetic HTTP core.
Requires Python Playwright and an installed permitted Chromium. No live profiles.
Usage: JOPLIN_WEB_MARKDOWN_MODULE=/path/to/markdown-it python3 web-browser.py /output/dir
"""
import json, os, pathlib, subprocess, sys
from playwright.sync_api import sync_playwright, expect
ROOT = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'web-browser-results').resolve()
OUT.mkdir(parents=True, exist_ok=True)
process = subprocess.Popen(['node', str(ROOT/'web-browser-fixture.mjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
observations=[]
def record(message):
    observations.append(message)
    print('PASS', message, flush=True)
def control(data):
    process.stdin.write(json.dumps(data)+'\n'); process.stdin.flush()
    return json.loads(process.stdout.readline())
try:
    ready=json.loads(process.stdout.readline()); assert ready['ready']
    base=ready['url']
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1440,'height':1100})
        page=context.new_page(); errors=[]; remote_requests=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('request',lambda r:remote_requests.append(r.url) if not r.url.startswith(base) and not r.url.startswith('about:') else None)
        page.goto(base)
        expect(page.locator('#login-panel')).to_be_visible()
        page.locator('#access-key').fill(ready['token']); page.locator('#login-form button').click()
        expect(page.locator('#workspace')).to_be_visible(); expect(page.locator('.note-button')).to_have_count(30)
        assert page.evaluate('document.cookie') == ''
        record('Login, HttpOnly session, and paginated metadata list')
        page.locator('#next').click(); expect(page.locator('#page-number')).to_have_text('Page 2');expect(page.locator('.note-button')).to_have_count(8)
        page.locator('#previous').click(); expect(page.locator('.note-button')).to_have_count(30)
        page.locator('[data-note-id="'+'a'*32+'"]').click()
        expect(page.locator('#title')).to_have_value('Welcome to your web notebook')
        expect(page.frame_locator('#preview').locator('h1')).to_have_text('A note, without a full download')
        assert page.frame_locator('#preview').locator('img,script,a').count()==0
        assert not page.evaluate('window.__noteScriptRan === true')
        assert not remote_requests, remote_requests
        record('Real Markdown rendering, inert HTML/images/links, and zero external note requests')
        page.screenshot(path=str(OUT/'desktop.png'),full_page=True)
        # A title-only edit must not round-trip normalized textarea newlines into the source.
        page.locator('[data-note-id="'+'d'*32+'"]').click();expect(page.locator('#title')).to_have_value('CRLF round trip')
        original=control({'type':'record','id':'d'*32})['body']
        page.locator('#title').fill('CRLF title changed');page.locator('#save').click();expect(page.locator('#save-status')).to_contain_text('Saved locally')
        assert control({'type':'record','id':'d'*32})['body']==original
        record('Title-only edit preserves the original CRLF body byte-for-byte')
        page.locator('#new-note').click();page.locator('#title').fill('Browser acceptance clip');page.locator('#body').fill('# 中文 and catatan\n\n![not fetched](file:///etc/passwd)\n\n`literal` **Markdown**')
        # Let the application commit and consume the reply, then drop it downstream.
        def lose_reply(route):
            response=route.fetch()
            assert response.status == 200
            route.abort('failed')
        page.route('**/api/write',lose_reply)
        before=control({'type':'stats'})['notes']
        page.locator('#save').click();expect(page.locator('#save')).to_have_text('Retry same save');expect(page.locator('#draft-status')).to_contain_text('Pending outcome')
        assert page.locator('#body').get_attribute('readonly') is not None
        assert control({'type':'stats'})['notes']==before+1
        page.unroute('**/api/write',lose_reply)
        page.locator('#save').click();expect(page.locator('#save-status')).to_contain_text('Requested content confirmed locally')
        assert control({'type':'stats'})['notes']==before+1
        record('Post-commit browser response loss retains a locked draft; exact retry confirms one note')
        # A disconnected page retains the edited source, and does not auto-retry on recovery.
        page.locator('#body').fill('Offline draft remains in this page.');context.set_offline(True)
        page.locator('#save').click();expect(page.locator('#draft-status')).to_contain_text('Pending outcome');expect(page.locator('#body')).to_have_value('Offline draft remains in this page.')
        context.set_offline(False);page.locator('#save').click();expect(page.locator('#save-status')).to_contain_text('Saved locally')
        record('Offline save failure retains source and requires an explicit same-request retry')
        # Find selected note ID from the real source fixture's last PUT.
        stats=control({'type':'stats'});nid=[c['route'].split('/')[-1] for c in stats['calls'] if c['method']=='PUT'][-1]
        page.locator('#body').fill('My retained draft')
        control({'type':'edit','id':nid,'changes':{'body':'A newer stock-style change'}})
        page.locator('#save').click();expect(page.locator('#save-status')).to_contain_text('changed elsewhere');expect(page.locator('#body')).to_have_value('My retained draft')
        assert control({'type':'record','id':nid})['body']=='A newer stock-style change'
        page.locator('#compare').click();expect(page.locator('#latest-body')).to_have_text('A newer stock-style change')
        page.once('dialog',lambda d:d.accept());page.locator('#rebase').click()
        page.locator('#body').fill('Merged: newer stock-style change plus my retained draft');page.locator('#save').click();expect(page.locator('#save-status')).to_contain_text('Saved locally')
        record('Observed stale edit rejected; compare/explicit rebase preserves and saves a manual merge')
        page.locator('#query').fill('Browser acceptance');page.locator('#mode').select_option('hybrid');page.locator('#search-form button[type=submit]').click()
        expect(page.locator('#search-status')).to_contain_text('keyword search');expect(page.locator('.note-button')).to_have_count(1)
        page.locator('#mode').select_option('semantic');page.locator('#search-form button[type=submit]').click();expect(page.locator('#search-status')).to_contain_text('Unavailable search')
        record('Keyword fallback and semantic-unavailable states are distinct from no matches')
        page.locator('#clear-search').click();expect(page.locator('.note-button')).to_have_count(30)
        page.locator('[data-note-id="'+'c'*32+'"]').click();expect(page.locator('#title')).to_have_value('HTML source example');expect(page.locator('#save')).to_be_disabled();assert page.locator('#body').get_attribute('readonly') is not None
        record('Unsupported HTML note stays readable as source and cannot be edited')
        page.locator('[data-note-id="'+'a'*32+'"]').click();expect(page.locator('#title')).to_have_value('Welcome to your web notebook')
        page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(OUT/'mobile.png'),full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        record('390-pixel responsive layout has no horizontal overflow')
        manifest=context.request.get(base+'/manifest.webmanifest').json();assert [i['sizes'] for i in manifest['icons']]==['192x192','512x512']
        assert page.evaluate('localStorage.length')==0 and page.evaluate('sessionStorage.length')==0
        assert page.evaluate('caches.keys()')==[] and page.evaluate('indexedDB.databases()')==[]
        record('Manifest/icons delivered; no localStorage, sessionStorage, Cache Storage, or IndexedDB note copies')
        page.locator('#logout').click();expect(page.locator('#login-panel')).to_be_visible();assert page.locator('#body').input_value()==''
        record('Logout revokes the session and clears displayed note/draft content')
        assert not errors, errors
        record('No uncaught browser JavaScript errors')
        (OUT/'RESULTS.json').write_text(json.dumps({'scope':'Actual Chromium UI, real gateway and private Data API adapter, synthetic in-memory HTTP core. No real Joplin/E2EE/remote HTTPS/OS-install acceptance.', 'browser':browser.version,'passed':observations,'errors':errors,'externalNoteRequests':remote_requests},indent=2)+'\n')
        context.close();browser.close()
finally:
    if process.poll() is None:
        process.stdin.write('{"type":"stop"}\n');process.stdin.flush()
        try: process.wait(timeout=12)
        except subprocess.TimeoutExpired: process.kill();process.wait()
    if process.returncode not in (0,None):
        print(process.stderr.read(),file=sys.stderr)
