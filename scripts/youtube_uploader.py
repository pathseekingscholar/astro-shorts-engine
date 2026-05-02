"""
YouTube uploader.

Uploads the most recently rendered script/video pair that has not already been uploaded.
This avoids reusing an old MP4 from videos_output with new metadata.
"""

import json
import os
from datetime import datetime

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    GOOGLE_API_AVAILABLE = True
    print("Google API libraries loaded")
except ImportError as e:
    GOOGLE_API_AVAILABLE = False
    print(f"Google API import error: {e}")


YOUTUBE_API_SERVICE_NAME = "youtube"
YOUTUBE_API_VERSION = "v3"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
DEFAULT_CATEGORY_ID = "28"
DEFAULT_PRIVACY = "public"
ALLOWED_PRIVACY_STATUSES = {"public", "unlisted", "private"}


def get_authenticated_service():
    token_json = os.environ.get("YOUTUBE_TOKEN")
    if not token_json:
        print("YOUTUBE_TOKEN environment variable not found")
        return None

    try:
        token_data = json.loads(token_json)
    except json.JSONDecodeError as e:
        print(f"Failed to parse YOUTUBE_TOKEN: {e}")
        return None

    client_secret_json = os.environ.get("YOUTUBE_CLIENT_SECRET")
    if not client_secret_json:
        print("YOUTUBE_CLIENT_SECRET environment variable not found")
        return None

    try:
        client_data = json.loads(client_secret_json)
        if "installed" in client_data:
            client_info = client_data["installed"]
        elif "web" in client_data:
            client_info = client_data["web"]
        else:
            client_info = client_data
    except json.JSONDecodeError as e:
        print(f"Failed to parse YOUTUBE_CLIENT_SECRET: {e}")
        return None

    credentials = Credentials(
        token=token_data.get("token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=token_data.get("client_id") or client_info.get("client_id"),
        client_secret=token_data.get("client_secret") or client_info.get("client_secret"),
        scopes=token_data.get("scopes", SCOPES),
    )

    if credentials.expired and credentials.refresh_token:
        print("Refreshing access token...")
        try:
            credentials.refresh(Request())
            print("Token refreshed successfully")
        except Exception as e:
            print(f"Failed to refresh token: {e}")
            return None

    try:
        service = build(YOUTUBE_API_SERVICE_NAME, YOUTUBE_API_VERSION, credentials=credentials)
        print("YouTube API service created")
        return service
    except Exception as e:
        print(f"Failed to build YouTube service: {e}")
        return None


def upload_video(service, video_path, title, description, tags, category_id=DEFAULT_CATEGORY_ID, privacy=DEFAULT_PRIVACY):
    if not os.path.exists(video_path):
        print(f"Video file not found: {video_path}")
        return None

    if "#Shorts" not in title and "#Shorts" not in description:
        title = f"{title} #Shorts"

    body = {
        "snippet": {
            "title": title[:100],
            "description": description[:5000],
            "tags": tags[:500] if tags else [],
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
    }

    media = MediaFileUpload(
        video_path,
        mimetype="video/mp4",
        resumable=True,
        chunksize=1024 * 1024,
    )

    try:
        print(f"Uploading: {video_path}")
        request = service.videos().insert(
            part=",".join(body.keys()),
            body=body,
            media_body=media,
        )

        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                progress = int(status.progress() * 100)
                print(f"Upload progress: {progress}%")

        video_id = response.get("id")
        print(f"Upload complete: https://youtube.com/shorts/{video_id}")
        return {
            "video_id": video_id,
            "url": f"https://youtube.com/shorts/{video_id}",
            "title": title,
            "uploaded_at": datetime.now().isoformat(),
        }
    except Exception as e:
        print(f"Upload failed: {e}")
        return None


def get_privacy_status():
    value = os.environ.get("YOUTUBE_PRIVACY_STATUS", DEFAULT_PRIVACY).strip().lower()
    if value not in ALLOWED_PRIVACY_STATUSES:
        print(f"Invalid YOUTUBE_PRIVACY_STATUS '{value}', using {DEFAULT_PRIVACY}")
        return DEFAULT_PRIVACY
    return value


def get_upload_candidates(scripts_dir="scripts_output"):
    """Use script files as the source of truth for what should be uploaded next."""
    if not os.path.exists(scripts_dir):
        return []

    candidates = []
    for filename in os.listdir(scripts_dir):
        if not filename.endswith(".json"):
            continue

        filepath = os.path.join(scripts_dir, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        if data.get("status") != "rendered":
            continue

        video_path = data.get("video_path")
        if not video_path or not os.path.exists(video_path):
            print(f"Rendered script missing video file: {filepath}")
            continue

        candidates.append(
            {
                "script_path": filepath,
                "script_data": data,
                "video_path": video_path,
                "rendered_at": data.get("rendered_at", ""),
            }
        )

    candidates.sort(key=lambda item: item.get("rendered_at", ""), reverse=True)
    return candidates


def get_upload_metadata(script_data):
    upload = script_data.get("upload") or {}
    if upload.get("title") and upload.get("description"):
        title = upload["title"]
        description = upload["description"]
        tags = upload.get("tags") or ["space", "nasa", "science", "astrophysics", "shorts"]
        return title, description, tags

    idea = script_data.get("idea", {})
    title = idea.get("title", "Astrophysics Short")
    hashtags = idea.get("hashtags", ["#Space", "#Astrophysics", "#Science"])
    hook = idea.get("hook", "")
    payoff = idea.get("payoff", "")

    description = f"""{hook}

{payoff}

{' '.join(hashtags)}

#Shorts #Space #Astrophysics #Science #SpaceFacts
"""

    tags = [tag.replace("#", "") for tag in hashtags]
    tags.extend(["Shorts", "Space", "Astrophysics", "Science", "SpaceFacts", "Astronomy"])
    return title, description, tags


def update_script_status(filepath, new_status, upload_info=None):
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    data["status"] = new_status
    data["uploaded_at"] = datetime.now().isoformat()
    if upload_info:
        data["youtube"] = upload_info

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def main():
    print("=" * 60)
    print("ASTRO SHORTS ENGINE - YouTube Uploader")
    print("=" * 60)
    print()

    if not GOOGLE_API_AVAILABLE:
        print("Google API libraries not installed")
        raise SystemExit(1)

    service = get_authenticated_service()
    if not service:
        print("Failed to authenticate with YouTube")
        raise SystemExit(1)

    candidates = get_upload_candidates()
    print(f"Found {len(candidates)} rendered video(s) waiting for upload")
    if not candidates:
        print("No videos to upload")
        return

    selected = candidates[0]
    script_path = selected["script_path"]
    script_data = selected["script_data"]
    video_path = selected["video_path"]

    print()
    print(f"Selected for upload: {os.path.basename(video_path)}")
    print("-" * 60)

    title, description, tags = get_upload_metadata(script_data)
    privacy = get_privacy_status()

    print(f"Title: {title}")
    print(f"Tags: {', '.join(tags[:5])}...")
    print(f"Privacy: {privacy}")
    print()

    result = upload_video(
        service,
        video_path,
        title,
        description,
        tags,
        privacy=privacy,
    )

    if result:
        update_script_status(script_path, "uploaded", result)
        print()
        print("=" * 60)
        print("VIDEO UPLOADED SUCCESSFULLY")
        print("=" * 60)
        print(f"Watch it: {result['url']}")
        print("=" * 60)
    else:
        print("Upload failed")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
