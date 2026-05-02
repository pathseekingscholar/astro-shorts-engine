"""
Analytics Agent
Reads YouTube performance data, tracks what works, and provides recommendations.
"""

import os
import json
from datetime import datetime, timedelta

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GOOGLE_API_AVAILABLE = True
    print("✅ Google API libraries loaded")
except ImportError as e:
    GOOGLE_API_AVAILABLE = False
    print(f"❌ Google API import error: {e}")


# =============================================================================
# CONFIGURATION
# =============================================================================
ANALYTICS_FILE = "data/analytics.json"
PERFORMANCE_FILE = "data/performance_history.json"
STRATEGY_FILE = "data/strategy.json"

# Performance scoring weights
WEIGHTS = {
    'views': 0.25,
    'watch_time': 0.25,
    'avg_view_duration': 0.30,
    'likes': 0.10,
    'comments': 0.10
}


# =============================================================================
# AUTHENTICATION
# =============================================================================
def get_authenticated_services():
    """Create authenticated YouTube and Analytics services."""
    
    token_json = os.environ.get('YOUTUBE_TOKEN')
    if not token_json:
        print("❌ YOUTUBE_TOKEN not found")
        return None, None
    
    try:
        token_data = json.loads(token_json)
    except json.JSONDecodeError as e:
        print(f"❌ Failed to parse token: {e}")
        return None, None
    
    client_secret_json = os.environ.get('YOUTUBE_CLIENT_SECRET')
    if client_secret_json:
        try:
            client_data = json.loads(client_secret_json)
            if 'installed' in client_data:
                client_info = client_data['installed']
            elif 'web' in client_data:
                client_info = client_data['web']
            else:
                client_info = client_data
        except:
            client_info = {}
    else:
        client_info = {}
    
    credentials = Credentials(
        token=token_data.get('token'),
        refresh_token=token_data.get('refresh_token'),
        token_uri=token_data.get('token_uri', 'https://oauth2.googleapis.com/token'),
        client_id=token_data.get('client_id') or client_info.get('client_id'),
        client_secret=token_data.get('client_secret') or client_info.get('client_secret'),
        scopes=token_data.get('scopes', [])
    )
    
    if credentials.expired and credentials.refresh_token:
        print("🔄 Refreshing token...")
        try:
            credentials.refresh(Request())
            print("✅ Token refreshed")
        except Exception as e:
            print(f"❌ Token refresh failed: {e}")
            return None, None
    
    try:
        youtube = build('youtube', 'v3', credentials=credentials)
        youtube_analytics = build('youtubeAnalytics', 'v2', credentials=credentials)
        print("✅ YouTube services created")
        return youtube, youtube_analytics
    except Exception as e:
        print(f"❌ Failed to build services: {e}")
        return None, None


# =============================================================================
# DATA COLLECTION
# =============================================================================
def get_channel_id(youtube):
    """Get the authenticated user's channel ID."""
    try:
        response = youtube.channels().list(
            part='id,snippet',
            mine=True
        ).execute()
        
        if response.get('items'):
            channel = response['items'][0]
            print(f"📺 Channel: {channel['snippet']['title']}")
            return channel['id']
        return None
    except Exception as e:
        print(f"❌ Error getting channel: {e}")
        return None


def get_recent_videos(youtube, max_results=20):
    """Get recently uploaded videos."""
    try:
        # Get uploads playlist
        channels_response = youtube.channels().list(
            part='contentDetails',
            mine=True
        ).execute()
        
        if not channels_response.get('items'):
            return []
        
        uploads_playlist_id = channels_response['items'][0]['contentDetails']['relatedPlaylists']['uploads']
        
        # Get videos from uploads playlist
        videos_response = youtube.playlistItems().list(
            part='snippet,contentDetails',
            playlistId=uploads_playlist_id,
            maxResults=max_results
        ).execute()
        
        videos = []
        for item in videos_response.get('items', []):
            video_id = item['contentDetails']['videoId']
            snippet = item['snippet']
            
            videos.append({
                'video_id': video_id,
                'title': snippet['title'],
                'published_at': snippet['publishedAt'],
                'description': snippet.get('description', '')[:200]
            })
        
        print(f"📹 Found {len(videos)} recent videos")
        return videos
        
    except Exception as e:
        print(f"❌ Error getting videos: {e}")
        return []


def get_video_statistics(youtube, video_ids):
    """Get statistics for specific videos."""
    if not video_ids:
        return {}
    
    try:
        response = youtube.videos().list(
            part='statistics',
            id=','.join(video_ids)
        ).execute()
        
        stats = {}
        for item in response.get('items', []):
            video_id = item['id']
            s = item['statistics']
            stats[video_id] = {
                'views': int(s.get('viewCount', 0)),
                'likes': int(s.get('likeCount', 0)),
                'comments': int(s.get('commentCount', 0))
            }
        
        return stats
        
    except Exception as e:
        print(f"❌ Error getting stats: {e}")
        return {}


def get_video_analytics(youtube_analytics, channel_id, video_id, days=7):
    """Get detailed analytics for a video."""
    try:
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')
        
        response = youtube_analytics.reports().query(
            ids=f'channel=={channel_id}',
            startDate=start_date,
            endDate=end_date,
            metrics='views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments',
            dimensions='video',
            filters=f'video=={video_id}'
        ).execute()
        
        if response.get('rows'):
            row = response['rows'][0]
            return {
                'views': row[1],
                'watch_time_minutes': row[2],
                'avg_view_duration_seconds': row[3],
                'average_view_percentage': row[4],
                'likes': row[5],
                'comments': row[6]
            }
        return None
        
    except Exception as e:
        try:
            response = youtube_analytics.reports().query(
                ids=f'channel=={channel_id}',
                startDate=start_date,
                endDate=end_date,
                metrics='views,estimatedMinutesWatched,averageViewDuration,likes,comments',
                dimensions='video',
                filters=f'video=={video_id}'
            ).execute()

            if response.get('rows'):
                row = response['rows'][0]
                return {
                    'views': row[1],
                    'watch_time_minutes': row[2],
                    'avg_view_duration_seconds': row[3],
                    'likes': row[4],
                    'comments': row[5]
                }
            return None
        except Exception:
            pass
        print(f"⚠️ Analytics not available for {video_id}: {e}")
        return None


# =============================================================================
# PERFORMANCE ANALYSIS
# =============================================================================
def calculate_performance_score(metrics, baseline=None):
    """Calculate a normalized performance score."""
    if not metrics:
        return 0
    
    # Default baseline for new channels
    if not baseline:
        baseline = {
            'views': 100,
            'watch_time_minutes': 10,
            'avg_view_duration_seconds': 15,
            'likes': 5,
            'comments': 1
        }
    
    scores = {}
    
    # Normalize each metric against baseline
    scores['views'] = min(metrics.get('views', 0) / max(baseline['views'], 1), 3.0)
    scores['watch_time'] = min(metrics.get('watch_time_minutes', 0) / max(baseline['watch_time_minutes'], 1), 3.0)
    scores['avg_view_duration'] = min(metrics.get('avg_view_duration_seconds', 0) / max(baseline['avg_view_duration_seconds'], 1), 3.0)
    scores['likes'] = min(metrics.get('likes', 0) / max(baseline['likes'], 1), 3.0)
    scores['comments'] = min(metrics.get('comments', 0) / max(baseline['comments'], 1), 3.0)
    
    # Weighted sum
    total = (
        WEIGHTS['views'] * scores['views'] +
        WEIGHTS['watch_time'] * scores['watch_time'] +
        WEIGHTS['avg_view_duration'] * scores['avg_view_duration'] +
        WEIGHTS['likes'] * scores['likes'] +
        WEIGHTS['comments'] * scores['comments']
    )
    
    return round(total, 3)


def extract_topic_family(title, description=""):
    """Determine the topic family from video title/description."""
    text = (title + " " + description).lower()
    
    if any(word in text for word in ['how long', 'travel', 'journey', 'reach', 'speed']):
        return 'travel_time'
    elif any(word in text for word in ['how many', 'fit', 'size', 'big', 'scale', 'compare']):
        return 'scale_comparison'
    elif any(word in text for word in ['what if', 'could you', 'survive', 'happen']):
        return 'hypothetical'
    elif any(word in text for word in ['myth', 'true', 'false', 'actually', 'really']):
        return 'myth_busting'
    elif any(word in text for word in ['fact', 'did you know', 'amazing']):
        return 'planetary_facts'
    else:
        return 'general'


def analyze_performance_patterns(performance_history):
    """Analyze patterns in video performance."""
    if not performance_history:
        return {}
    
    # Group by topic family
    by_topic = {}
    for video in performance_history:
        topic = video.get('topic_family', 'general')
        if topic not in by_topic:
            by_topic[topic] = []
        by_topic[topic].append(video.get('performance_score', 0))
    
    # Calculate average per topic
    topic_scores = {}
    for topic, scores in by_topic.items():
        if scores:
            topic_scores[topic] = {
                'avg_score': round(sum(scores) / len(scores), 3),
                'count': len(scores),
                'best': round(max(scores), 3),
                'worst': round(min(scores), 3)
            }
    
    return topic_scores


# =============================================================================
# STRATEGY RECOMMENDATIONS
# =============================================================================
def generate_recommendations(topic_scores, performance_history):
    """Generate content strategy recommendations."""
    recommendations = {
        'generated_at': datetime.now().isoformat(),
        'top_performing_topics': [],
        'avoid_topics': [],
        'suggested_next': [],
        'insights': []
    }
    
    if not topic_scores:
        recommendations['insights'].append("Not enough data yet. Keep posting!")
        recommendations['suggested_next'] = ['scale_comparison', 'travel_time', 'planetary_facts']
        return recommendations
    
    # Sort topics by performance
    sorted_topics = sorted(topic_scores.items(), key=lambda x: x[1]['avg_score'], reverse=True)
    
    # Top performing
    for topic, stats in sorted_topics[:3]:
        if stats['count'] >= 1:
            recommendations['top_performing_topics'].append({
                'topic': topic,
                'avg_score': stats['avg_score'],
                'videos_count': stats['count']
            })
    
    # Underperforming (if enough data)
    for topic, stats in sorted_topics[-2:]:
        if stats['count'] >= 2 and stats['avg_score'] < 0.5:
            recommendations['avoid_topics'].append({
                'topic': topic,
                'avg_score': stats['avg_score'],
                'reason': 'Below average performance'
            })
    
    # Suggest next topics (prioritize top performers)
    for topic, stats in sorted_topics[:3]:
        recommendations['suggested_next'].append(topic)
    
    # Generate insights
    if sorted_topics:
        best_topic = sorted_topics[0][0]
        best_score = sorted_topics[0][1]['avg_score']
        recommendations['insights'].append(f"'{best_topic}' is your best performing format (score: {best_score})")
    
    total_videos = sum(s['count'] for s in topic_scores.values())
    recommendations['insights'].append(f"Analyzed {total_videos} videos across {len(topic_scores)} topic types")
    
    return recommendations


# =============================================================================
# DATA PERSISTENCE
# =============================================================================
def ensure_data_dir():
    """Create data directory if it doesn't exist."""
    if not os.path.exists('data'):
        os.makedirs('data')
        print("📁 Created data directory")


def load_json(filepath, default=None):
    """Load JSON file or return default."""
    if os.path.exists(filepath):
        try:
            with open(filepath, 'r') as f:
                return json.load(f)
        except:
            pass
    return default if default is not None else {}


def save_json(filepath, data):
    """Save data to JSON file."""
    ensure_data_dir()
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)


# =============================================================================
# MAIN
# =============================================================================
def main():
    print("=" * 60)
    print("📊 ASTRO SHORTS ENGINE - Analytics Agent")
    print("=" * 60)
    print()
    
    if not GOOGLE_API_AVAILABLE:
        print("❌ Google API libraries not available")
        exit(1)
    
    # Authenticate
    youtube, youtube_analytics = get_authenticated_services()
    if not youtube:
        print("❌ Authentication failed")
        exit(1)
    
    # Get channel ID
    channel_id = get_channel_id(youtube)
    if not channel_id:
        print("❌ Could not get channel ID")
        exit(1)
    
    print()
    print("-" * 60)
    print("📹 Fetching recent videos...")
    print("-" * 60)
    
    # Get recent videos
    videos = get_recent_videos(youtube, max_results=20)
    if not videos:
        print("⚠️ No videos found")
        return
    
    # Get statistics
    video_ids = [v['video_id'] for v in videos]
    stats = get_video_statistics(youtube, video_ids)
    
    # Load existing performance history
    performance_history = load_json(PERFORMANCE_FILE, [])
    existing_ids = {v['video_id'] for v in performance_history}
    
    print()
    print("-" * 60)
    print("📈 Analyzing performance...")
    print("-" * 60)
    
    # Analyze each video
    new_entries = 0
    for video in videos:
        video_id = video['video_id']
        
        # Get or fetch metrics
        video_stats = stats.get(video_id, {})
        
        # Get detailed analytics if available
        detailed = get_video_analytics(youtube_analytics, channel_id, video_id)
        if detailed:
            video_stats.update(detailed)
        
        # Calculate performance score
        score = calculate_performance_score(video_stats)
        
        # Determine topic family
        topic_family = extract_topic_family(video['title'], video.get('description', ''))
        
        # Create performance entry
        entry = {
            'video_id': video_id,
            'title': video['title'],
            'published_at': video['published_at'],
            'topic_family': topic_family,
            'metrics': video_stats,
            'performance_score': score,
            'analyzed_at': datetime.now().isoformat()
        }
        
        print(f"  📊 {video['title'][:40]}...")
        print(f"      Views: {video_stats.get('views', 0)} | Score: {score} | Type: {topic_family}")
        
        # Update or add to history
        if video_id in existing_ids:
            # Update existing entry
            for i, v in enumerate(performance_history):
                if v['video_id'] == video_id:
                    performance_history[i] = entry
                    break
        else:
            performance_history.append(entry)
            new_entries += 1
    
    print()
    print(f"✅ Analyzed {len(videos)} videos ({new_entries} new)")
    
    # Analyze patterns
    print()
    print("-" * 60)
    print("🧠 Generating insights...")
    print("-" * 60)
    
    topic_scores = analyze_performance_patterns(performance_history)
    recommendations = generate_recommendations(topic_scores, performance_history)
    
    # Print insights
    print()
    for insight in recommendations.get('insights', []):
        print(f"  💡 {insight}")
    
    if recommendations.get('top_performing_topics'):
        print()
        print("  🏆 Top performing topics:")
        for topic in recommendations['top_performing_topics']:
            print(f"      • {topic['topic']}: score {topic['avg_score']} ({topic['videos_count']} videos)")
    
    if recommendations.get('suggested_next'):
        print()
        print(f"  🎯 Suggested next topics: {', '.join(recommendations['suggested_next'])}")
    
    # Save data
    save_json(PERFORMANCE_FILE, performance_history)
    save_json(STRATEGY_FILE, recommendations)
    save_json(ANALYTICS_FILE, {
        'last_run': datetime.now().isoformat(),
        'channel_id': channel_id,
        'videos_analyzed': len(videos),
        'topic_scores': topic_scores
    })
    
    print()
    print("=" * 60)
    print("✅ Analytics complete!")
    print("=" * 60)
    print(f"📁 Data saved to: {PERFORMANCE_FILE}")
    print(f"📁 Strategy saved to: {STRATEGY_FILE}")
    print("=" * 60)


if __name__ == "__main__":
    main()
