# usage: python3 test/e2e_returning.py http://localhost:3000 <admin-temp-password>
import sys, re
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]; PW = sys.argv[2]
errs = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
PHONE = '01155550123'
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(bypass_csp=True, viewport={'width':1100,'height':900}, locale='ar-EG')
    site = ctx.new_page(); logs = []
    site.on('pageerror', lambda e: logs.append(str(e)))
    site.goto(BASE + '/'); site.wait_for_timeout(2600)
    # عميل جديد
    site.fill('#fullName', 'منى إبراهيم'); site.fill('#phoneNumber', PHONE)
    site.fill('#addressDetails', 'الشيخ زايد الحي 7 فيلا 12'); site.select_option('#serviceType', index=1)
    site.click('.submit-btn'); site.wait_for_selector('#confirmationModal.open'); site.click('#modalConfirmBtn')
    # الكاشير: تحويل لإنشاء العميل
    page = ctx.new_page(); cl = []
    page.on('pageerror', lambda e: cl.append(str(e)))
    page.goto(BASE + '/app/')
    page.fill('#login-username', 'admin'); page.fill('#login-password', PW); page.click('#login-form button[type=submit]')
    page.wait_for_selector('#password-dialog[open]')
    page.fill('#pw-new', 'Laundry2026ok'); page.fill('#pw-confirm', 'Laundry2026ok'); page.click('#password-form button[type=submit]')
    page.wait_for_selector('#dashboard.active')
    page.click('[data-view=requests]'); page.wait_for_selector('#requests-table [data-rconvert]')
    page.click('#requests-table [data-rconvert]'); page.wait_for_selector('#pos.active .selected-customer')
    code = page.evaluate("fetch('/api/customers?q=%s').then(r=>r.json()).then(j=>(j.items||j)[0].code)" % PHONE)
    ok(bool(re.match(r'4S-C-\d+', code)), 'customer code ' + code)

    # ---- عميل سابق بالكود ----
    site.reload(); site.wait_for_timeout(2600)
    site.check('input[name=customerType][value=returning]')
    ok(site.is_hidden('#fullName') and site.is_visible('#lookupTerm'), 'toggle shows returning panel')
    site.fill('#lookupTerm', code); site.click('#lookupBtn')
    site.wait_for_selector('#last4', state='visible')
    site.fill('#last4', '0000'); site.click('#verifyBtn')
    site.wait_for_function("document.querySelector('[data-for=verify]').textContent.length>0")
    ok(True, 'wrong last4 rejected: ' + site.inner_text('[data-for=verify]'))
    site.fill('#last4', PHONE[-4:]); site.click('#verifyBtn')
    site.wait_for_selector('#stepProfile', state='visible')
    ok(site.inner_text('#pName') == 'منى إبراهيم' and PHONE in site.inner_text('#pPhone'), 'profile shows full data after verify')
    site.screenshot(path='shots/ret-profile.png')
    site.click('#editBtn'); site.fill('#editAddress', 'التجمع الخامس الحي 3 عمارة 9'); site.click('#saveEditBtn')
    site.wait_for_function("document.querySelector('#profileMsg') && !document.querySelector('#profileMsg').hidden")
    ok('التجمع' in site.inner_text('#pAddress'), 'edit address saved')
    site.select_option('#serviceType', index=2)
    site.click('.submit-btn'); site.wait_for_selector('#confirmationModal.open')
    ok('منى' in site.inner_text('#modalCustomerName'), 'returning order confirmed')
    site.click('#modalConfirmBtn')
    ok(site.is_visible('#fullName'), 'form reset to new-customer after submit')

    # ---- عميل سابق بالهاتف + OTP يدوي عبر الكاشير ----
    site.check('input[name=customerType][value=returning]')
    site.fill('#lookupTerm', PHONE); site.click('#lookupBtn')
    site.wait_for_selector('#otpSendBtn', state='visible')
    hint = site.inner_text('#verifyIntro')
    ok('*' in hint and 'إبراهيم' not in hint and PHONE not in hint, 'phone lookup shows masked hint: ' + hint)
    site.click('#otpSendBtn'); site.wait_for_selector('#otpCode', state='visible')
    page.click('[data-view=requests]'); page.click('#refresh-requests'); page.wait_for_selector('#otp-list li .otp-code')
    otp = page.inner_text('#otp-list li .otp-code').strip()
    ok(re.fullmatch(r'\d{6}', otp) is not None, 'cashier sees OTP')
    ok(page.is_visible('#requests-badge'), 'badge visible')
    page.screenshot(path='shots/cashier-otp.png')
    site.fill('#otpCode', otp); site.click('#verifyBtn')
    site.wait_for_selector('#stepProfile', state='visible')
    site.select_option('#serviceType', index=1); site.click('.submit-btn')
    site.wait_for_selector('#confirmationModal.open'); site.click('#modalConfirmBtn')
    page.click('#refresh-requests'); page.wait_for_selector('#requests-table .ret-tag')
    ok(page.locator('#requests-table .ret-tag').count() >= 2, 'cashier table tags returning requests')
    page.screenshot(path='shots/cashier-requests.png')
    # موبايل
    site.set_viewport_size({'width':390,'height':800}); site.reload(); site.wait_for_timeout(500)
    site.check('input[name=customerType][value=returning]'); site.locator('#orderForm').scroll_into_view_if_needed()
    site.screenshot(path='shots/ret-mobile.png')
    real = [l for l in logs+cl]
    ok(not real, 'no JS errors ' + str(real))
    b.close()
print('\nFAILED' if errs else '\nALL PASS'); sys.exit(1 if errs else 0)
