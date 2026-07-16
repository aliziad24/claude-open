from pathlib import Path
from playwright.sync_api import sync_playwright

output = Path("test-results/browser")
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    page = context.new_page()
    errors = []
    page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(str(exc)))

    page.goto("http://127.0.0.1:43199", wait_until="domcontentloaded")
    page.get_by_label("Pairing code").fill("123456")
    page.get_by_role("button", name="Pair securely").click()
    page.get_by_text("Ready when you are").wait_for()
    page.locator("#model-select option[value='mobile-model']").wait_for(state="attached")
    assert page.get_by_label("Model", exact=True).input_value() == "mobile-model"
    page.get_by_label("Reasoning effort", exact=True).select_option("high")
    page.get_by_label("Message", exact=True).fill("Test reconnect")
    page.get_by_role("button", name="Send message").click()
    page.get_by_role("button", name="Stop").wait_for()

    context.set_offline(True)
    page.get_by_text("Offline", exact=True).wait_for()
    page.wait_for_timeout(1000)
    context.set_offline(False)
    page.wait_for_function("navigator.onLine === true")
    # Playwright's network emulation restores connectivity but does not
    # consistently dispatch the browser's online event on Windows Chromium.
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.get_by_text("Connected", exact=True).wait_for(timeout=10000)
    page.get_by_text("Connected through a secure resumable stream.", exact=True).wait_for(timeout=10000)
    page.screenshot(path=str(output / "remote-companion-mobile.png"), full_page=True)

    assert not errors, f"browser console errors: {errors}"
    browser.close()
