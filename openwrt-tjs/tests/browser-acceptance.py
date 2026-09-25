import argparse
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


sys.stdout.reconfigure(encoding='utf-8')

origin = os.environ.get('PROXY_ORIGIN', 'http://127.0.0.1:5344')
password = os.environ.get('APP_PASSWORD', '')
alist_password = os.environ.get('ALIST_PASSWORD', '')
output_dir = Path(os.environ['BROWSER_OUTPUT_DIR']) if os.environ.get('BROWSER_OUTPUT_DIR') else (
    Path(__file__).resolve().parent.parent / 'output' / 'playwright'
)
output_dir.mkdir(parents=True, exist_ok=True)
argparse.ArgumentParser(description='Run the OpenWrt txiki.js browser acceptance flow').parse_args()


def safe_url(value):
    return re.sub(r'(?i)([?&]sign=)[^&\s]+', r'\1[REDACTED]', str(value))


console_errors = []
page_errors = []
request_failures = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('requestfailed', lambda request: request_failures.append({'url': safe_url(request.url), 'failure': request.failure}))

    page.goto(f'{origin}/index', wait_until='networkidle')
    page.wait_for_timeout(1000)
    page.screenshot(path=str(output_dir / 'config-login.png'), full_page=True)
    print('BROWSER_INSPECT', {'url': safe_url(page.url), 'title': page.title(), 'inputs': page.locator('input').count(), 'buttons': page.locator('button').count()})
    print('BROWSER_INPUTS', page.locator('input').evaluate_all("els => els.map(el => ({type: el.type, name: el.name, placeholder: el.placeholder, aria: el.getAttribute('aria-label')}))"))
    print('BROWSER_BUTTONS', page.locator('button').all_text_contents())
    print('BROWSER_BODY_CHARS', len(page.locator('body').inner_text()))

    if not password:
        raise RuntimeError('APP_PASSWORD is required')
    inputs = page.locator('input')
    if inputs.count() < 2:
        raise RuntimeError('configuration login form was not rendered')
    inputs.nth(0).fill('admin')
    inputs.nth(1).fill(password)
    page.locator('button').last.click()
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(1000)
    page.screenshot(path=str(output_dir / 'config-home.png'), full_page=True)
    print('BROWSER_CONFIG', {'url': safe_url(page.url), 'title': page.title(), 'body_chars': len(page.locator('body').inner_text())})

    page.goto(f'{origin}/', wait_until='networkidle')
    page.wait_for_timeout(1000)
    print('BROWSER_ALIST_LOGIN', {
        'url': safe_url(page.url),
        'inputs': page.locator('input').count(),
        'buttons': page.locator('button').count(),
        'input_details': page.locator('input').evaluate_all("els => els.map(el => ({type: el.type, name: el.name, placeholder: el.placeholder, autocomplete: el.autocomplete}))"),
        'button_details': page.locator('button').evaluate_all("els => els.map(el => ({text: el.innerText, type: el.type, aria: el.getAttribute('aria-label')}))"),
    })
    if '@login' in page.url:
        if not alist_password:
            raise RuntimeError('ALIST_PASSWORD is required')
        page.locator('input[name="username"]').fill('admin')
        page.locator('input[type="password"]').fill(alist_password)
        page.locator('button').nth(1).click()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1500)
        if '@login' in page.url:
            raise RuntimeError(f'AList browser login did not complete: {safe_url(page.url)}')
        page.goto(f'{origin}/', wait_until='networkidle')
        page.wait_for_timeout(1000)
    page.screenshot(path=str(output_dir / 'proxy-home.png'), full_page=True)
    print('BROWSER_PROXY', {'url': safe_url(page.url), 'title': page.title(), 'body_chars': len(page.locator('body').inner_text())})
    print('BROWSER_ERRORS', {'console': [safe_url(item) for item in console_errors], 'page': [safe_url(item) for item in page_errors], 'requests': request_failures})
    browser.close()
