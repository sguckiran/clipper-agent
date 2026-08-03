"""Standalone TikTok/Instagram browser publisher.

This is intentionally a small bridge around the useful brainrot-automater publisher
pattern: one persistent Chromium profile per platform, populated by manual login, then
reused for upload/post. It accepts JSON on stdin and writes JSON on stdout so the Node
app can call it as a subprocess.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PLATFORM_URLS = {
    "instagram": "https://www.instagram.com/",
    "tiktok": "https://www.tiktok.com/tiktokstudio/upload",
}

LOGIN_URLS = {
    "instagram": "https://www.instagram.com/",
    "tiktok": "https://www.tiktok.com/login",
}


class PublishNeedsHuman(RuntimeError):
    """Login, verification, captcha, or UI selector drift requires manual attention."""


def _platform(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in PLATFORM_URLS:
        raise ValueError(f"unsupported platform: {value!r}")
    return normalized


@dataclass
class Settings:
    data_dir: Path
    profile_dir: Path | None = None
    browser_executable: str | None = None
    headless: bool = False

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Settings":
        data_dir = Path(str(payload.get("data_dir") or os.environ.get("CLIPPER_DATA_DIR") or ".clipper-data"))
        profile_raw = payload.get("profile_dir") or os.environ.get("CLIPPER_PUBLISH_PROFILE_DIR")
        executable = payload.get("browser_executable") or os.environ.get("CLIPPER_PUBLISH_BROWSER_EXECUTABLE")
        headless_raw = payload.get("headless", os.environ.get("CLIPPER_PUBLISH_HEADLESS", "false"))
        headless = str(headless_raw).strip().lower() in {"1", "true", "yes", "on"}
        return cls(
            data_dir=data_dir,
            profile_dir=Path(str(profile_raw)) if profile_raw else None,
            browser_executable=str(executable) if executable else None,
            headless=headless,
        )

    def social_profile_dir(self, platform: str) -> Path:
        base = self.profile_dir or (self.data_dir / "social_profiles")
        path = base / _platform(platform)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def logs_dir(self) -> Path:
        path = self.data_dir / "logs" / "publisher"
        path.mkdir(parents=True, exist_ok=True)
        return path


def _visible(locator: Any) -> bool:
    try:
        return locator.count() > 0 and locator.first.is_visible()
    except Exception:
        return False


def _visible_match(locator: Any) -> Any | None:
    try:
        for index in range(locator.count()):
            candidate = locator.nth(index)
            if candidate.is_visible():
                return candidate
    except Exception:
        return None
    return None


def _first_visible(page: Any, selectors: list[str], timeout_s: float = 20) -> Any:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        for selector in selectors:
            candidate = _visible_match(page.locator(selector))
            if candidate is not None:
                return candidate
        page.wait_for_timeout(300)
    raise PublishNeedsHuman("expected upload control was not found; platform UI may have changed")


def _role(page: Any, role: str, names: list[str], timeout_s: float = 20) -> Any:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        for name in names:
            locator = page.get_by_role(role, name=re.compile(name, re.I))
            if _visible(locator):
                return locator.first
        page.wait_for_timeout(300)
    raise PublishNeedsHuman(f"could not find expected {role}: {', '.join(names)}")


def _check_blocking_screen(page: Any, platform: str) -> None:
    try:
        text = page.inner_text("body").lower()
    except Exception:
        text = page.content().lower()
    login_controls = (
        "input[name='username']",
        "input[name='password']",
        "form[action*='login' i]",
    )
    markers = (
        "verify it's you",
        "verify your identity",
        "security check",
        "suspicious activity",
        "captcha",
        "too many attempts",
    )
    if any(_visible(page.locator(selector)) for selector in login_controls) or any(
        marker in text for marker in markers
    ):
        raise PublishNeedsHuman(f"{platform} requires login or verification in its saved profile")


def _set_files(page: Any, media_path: Path) -> None:
    try:
        page.locator("input[type='file']").first.set_input_files(str(media_path), timeout=20000)
    except Exception as exc:
        raise PublishNeedsHuman("could not find or use the video upload input") from exc


def _set_instagram_media(page: Any, media_path: Path) -> None:
    upload = page.locator("[role='dialog'] input[type='file']")
    if upload.count() == 0:
        upload = page.locator("input[type='file']")
    if upload.count() > 0:
        upload.first.set_input_files(str(media_path))
        return

    select_button = _role(page, "button", [r"^Select from computer$"], timeout_s=20)
    try:
        with page.expect_file_chooser(timeout=20000) as chooser_info:
            select_button.click()
        chooser_info.value.set_files(str(media_path))
    except Exception as exc:
        raise PublishNeedsHuman("Instagram's video file chooser could not be used") from exc


def _click_if_visible(locator: Any) -> bool:
    if not _visible(locator):
        return False
    locator.first.click()
    return True


def _wait_for_enabled(locator: Any, timeout_s: float = 60) -> Any:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _visible(locator):
            try:
                if locator.first.is_enabled():
                    return locator.first
            except Exception:
                pass
        time.sleep(0.3)
    raise PublishNeedsHuman("publish control never became ready")


def _wait_for_publish_result(
    page: Any,
    success_patterns: list[str],
    *,
    timeout_s: float = 120,
    success_url_excludes: str | None = None,
) -> None:
    deadline = time.monotonic() + timeout_s
    combined = re.compile("|".join(success_patterns), re.I)
    while time.monotonic() < deadline:
        try:
            if page.is_closed():
                raise PublishNeedsHuman("platform closed the upload page before success was confirmed")
            if success_url_excludes and success_url_excludes not in page.url:
                return
            body = page.locator("body").inner_text(timeout=2000)
            if combined.search(body):
                return
        except PublishNeedsHuman:
            raise
        except Exception:
            pass
        time.sleep(0.5)
    raise PublishNeedsHuman("no successful publish confirmation appeared")


def _dismiss_tiktok_tour(page: Any) -> None:
    for _ in range(8):
        overlay = page.locator("[data-test-id='overlay']")
        if not _visible(overlay):
            return
        got_it = _visible_match(page.get_by_role("button", name="Got it", exact=True))
        if got_it is None:
            raise PublishNeedsHuman("TikTok onboarding overlay is blocking the Post button")
        got_it.click()
        page.wait_for_timeout(400)
    if _visible(page.locator("[data-test-id='overlay']")):
        raise PublishNeedsHuman("TikTok onboarding tour could not be dismissed")


def _publish_instagram(page: Any, media_path: Path, caption: str) -> None:
    page.goto(PLATFORM_URLS["instagram"], wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    _check_blocking_screen(page, "instagram")

    create = page.locator("a:has(svg[aria-label='New post'])")
    if not _visible(create):
        raise PublishNeedsHuman("Instagram New post (+) control was not found")
    create.first.click()

    _set_instagram_media(page, media_path)
    page.wait_for_timeout(1500)
    _click_if_visible(page.get_by_role("button", name="OK", exact=True))

    crop_button = _first_visible(page, ["[role='dialog'] button:has(svg[aria-label='Select crop'])"], timeout_s=10)
    crop_button.click()
    vertical = _first_visible(page, ["[role='dialog'] [role='button']:has-text('9:16')"], timeout_s=10)
    if vertical.inner_text().strip() != "9:16":
        raise PublishNeedsHuman("Instagram exact 9:16 crop option was not found")
    vertical.click()

    for _ in range(2):
        next_button = _first_visible(
            page,
            [
                "[role='dialog'] [role='button']:has-text('Next')",
                "[role='dialog'] button:has-text('Next')",
            ],
            timeout_s=30,
        )
        next_button.click()
        page.wait_for_timeout(1000)

    caption_box = page.locator("[role='dialog'] [role='textbox'][aria-label='Write a caption...']")
    if not _visible(caption_box):
        raise PublishNeedsHuman("Instagram caption field was not found")
    caption_box.fill(caption)
    share = _first_visible(
        page,
        ["[role='dialog'] [role='button']:has-text('Share')", "[role='dialog'] button:has-text('Share')"],
        timeout_s=20,
    )
    share.click()
    _wait_for_publish_result(
        page,
        [r"your reel has been shared", r"your post has been shared", r"reel shared", r"post shared"],
    )


def _publish_tiktok(page: Any, media_path: Path, caption: str) -> None:
    page.goto(PLATFORM_URLS["tiktok"], wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    _check_blocking_screen(page, "tiktok")
    _set_files(page, media_path)

    uploaded = page.locator("[data-e2e='upload_status_container']:has-text('Uploaded')")
    _first_visible(page, ["[data-e2e='upload_status_container']:has-text('Uploaded')"], timeout_s=60)
    if not _visible(uploaded):
        raise PublishNeedsHuman("TikTok did not confirm that the video uploaded")

    caption_box = page.locator("[data-e2e='caption_container'] [contenteditable='true'][role='combobox']")
    if not _visible(caption_box):
        raise PublishNeedsHuman("TikTok description field was not found")
    caption_box.fill(caption)

    ai_switch = page.locator(
        "[data-e2e='aigc_container'] input[role='switch'], "
        "[data-e2e='aigc_container'] input[type='checkbox']"
    )
    if _visible(ai_switch) and not ai_switch.first.is_checked():
        ai_switch.first.check()

    _dismiss_tiktok_tour(page)
    _wait_for_enabled(page.locator("button[data-e2e='post_video_button']"), timeout_s=60).click()

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        post_now = _visible_match(page.get_by_role("button", name="Post now", exact=True))
        if post_now is not None:
            post_now.click()
            break
        if "/tiktokstudio/upload" not in page.url:
            break
        time.sleep(0.25)

    _wait_for_publish_result(
        page,
        [
            r"uploaded successfully",
            r"posted successfully",
            r"published successfully",
            r"your video is being uploaded",
            r"your video has been posted",
        ],
        success_url_excludes="/tiktokstudio/upload",
    )


def _launch_context(settings: Settings, platform: str) -> tuple[Any, Any, Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Python Playwright is not installed. Run: python -m pip install playwright && python -m playwright install chromium"
        ) from exc

    pw = sync_playwright().start()
    try:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(settings.social_profile_dir(platform)),
            headless=settings.headless,
            accept_downloads=True,
            executable_path=settings.browser_executable,
        )
        page = context.pages[0] if context.pages else context.new_page()
        return pw, context, page
    except Exception:
        pw.stop()
        raise


def _screenshot(page: Any, settings: Settings, label: str) -> str | None:
    try:
        path = settings.logs_dir() / f"{label}.png"
        page.screenshot(path=str(path))
        return str(path)
    except Exception:
        return None


def publish(payload: dict[str, Any]) -> dict[str, Any]:
    settings = Settings.from_payload(payload)
    media_path = Path(str(payload.get("media_path") or ""))
    if not media_path.is_file():
        raise FileNotFoundError(f"media file not found: {media_path}")
    caption = str(payload.get("caption") or "")
    platforms = [_platform(str(p)) for p in payload.get("platforms", ["tiktok", "instagram"])]

    results: list[dict[str, Any]] = []
    for platform in platforms:
        pw = context = page = None
        try:
            pw, context, page = _launch_context(settings, platform)
            if platform == "instagram":
                _publish_instagram(page, media_path, caption)
            else:
                _publish_tiktok(page, media_path, caption)
            results.append({"platform": platform, "status": "published"})
        except PublishNeedsHuman as exc:
            screenshot = _screenshot(page, settings, f"{media_path.stem}_{platform}_needs_human") if page else None
            results.append({"platform": platform, "status": "needs_human", "error": str(exc), "screenshot": screenshot})
        except Exception as exc:
            screenshot = _screenshot(page, settings, f"{media_path.stem}_{platform}_error") if page else None
            results.append({"platform": platform, "status": "failed", "error": str(exc), "screenshot": screenshot})
        finally:
            try:
                if context is not None:
                    context.close()
            finally:
                if pw is not None:
                    pw.stop()
    return {"ok": all(r["status"] == "published" for r in results), "results": results}


def _find_chrome(explicit: str | None) -> str:
    if explicit:
        return explicit
    candidates = [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for candidate in candidates:
        resolved = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if resolved:
            return resolved
    raise RuntimeError("Chrome/Chromium executable not found; set CLIPPER_PUBLISH_BROWSER_EXECUTABLE")


def login(payload: dict[str, Any]) -> dict[str, Any]:
    settings = Settings.from_payload(payload)
    platform = _platform(str(payload.get("platform") or ""))
    profile = settings.social_profile_dir(platform)
    executable = _find_chrome(settings.browser_executable)
    cmd = [
        executable,
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        LOGIN_URLS[platform],
    ]
    proc = subprocess.Popen(cmd)
    try:
        input(f"Log in to {platform} in the opened browser, then press Enter here to save the session...")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    return {"ok": True, "platform": platform, "profile_dir": str(profile)}


def main() -> int:
    payload = json.loads(os.environ.get("CLIPPER_PUBLISH_PAYLOAD") or sys.stdin.read() or "{}")
    action = str(payload.get("action") or "publish")
    try:
        if action == "login":
            result = login(payload)
        elif action == "publish":
            result = publish(payload)
        else:
            raise ValueError(f"unsupported action: {action}")
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
