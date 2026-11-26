"use client";

import { useState } from "react";
import { Loader2, Plus, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import {
  STAFF_VIDEOS_MAX,
  STAFF_VIDEO_NOTE_MAX,
  STAFF_VIDEO_TITLE_MAX,
  type StaffVideo,
} from "@/lib/staff-videos";

function isHttpsLink(value: string) {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Settings > Videos: walkthroughs and demo videos for the team. Only
 * administrators can open Settings, so nothing here reaches clients.
 */
export function VideosTab() {
  const utils = trpc.useUtils();
  const videos = trpc.settings.listStaffVideos.useQuery();
  const save = trpc.settings.updateStaffVideos.useMutation({
    onSuccess: (saved) => {
      utils.settings.listStaffVideos.setData(undefined, saved);
    },
    onError: (err) => toast.error(err.message),
  });

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");

  const list = videos.data ?? [];

  function persist(next: StaffVideo[], message: string) {
    save.mutate(
      {
        videos: next.map((v) => ({
          title: v.title,
          url: v.url,
          posterUrl: v.posterUrl ?? "",
          note: v.note ?? "",
        })),
      },
      { onSuccess: () => toast.success(message) },
    );
  }

  function addVideo() {
    if (!title.trim() || !isHttpsLink(url)) return;
    persist(
      [
        ...list,
        { title: title.trim(), url: url.trim(), posterUrl: null, note: note.trim() || null },
      ],
      "Video added",
    );
    setTitle("");
    setUrl("");
    setNote("");
    setAdding(false);
  }

  function removeVideo(index: number) {
    persist(
      list.filter((_, i) => i !== index),
      "Video removed",
    );
  }

  if (videos.isLoading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading videos...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-heading text-lg font-semibold">Videos</h3>
          <p className="text-sm text-muted-foreground">
            App walkthroughs and demo videos for your team. Only
            administrators can see this page; clients never do.
          </p>
        </div>
        {!adding && list.length < STAFF_VIDEOS_MAX && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add video
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="staff-video-title">
              Title
            </label>
            <Input
              id="staff-video-title"
              value={title}
              maxLength={STAFF_VIDEO_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="App demo: a video recheck"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="staff-video-url">
              Video link (https)
            </label>
            <Input
              id="staff-video-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/media/demo.mp4"
            />
            {url.trim() !== "" && !isHttpsLink(url) && (
              <p className="text-xs text-destructive">
                Use a full https:// link to the video file.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="staff-video-note">
              Note (optional)
            </label>
            <Input
              id="staff-video-note"
              value={note}
              maxLength={STAFF_VIDEO_NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={addVideo}
              disabled={save.isPending || !title.trim() || !isHttpsLink(url)}
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save video
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {list.length === 0 && !adding ? (
        <EmptyState
          icon={Video}
          title="No videos yet"
          description="Add a link to a walkthrough or demo video to keep it here for your team."
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          {list.map((video, index) => (
            <figure
              key={`${video.url}-${index}`}
              className="min-w-0 overflow-hidden rounded-xl border bg-card"
            >
              <video
                controls
                playsInline
                preload="metadata"
                poster={video.posterUrl ?? undefined}
                className="aspect-video w-full bg-black"
                aria-label={video.title}
              >
                <source src={video.url} />
              </video>
              <figcaption className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium">{video.title}</p>
                  {video.note && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {video.note}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${video.title}`}
                  disabled={save.isPending}
                  onClick={() => removeVideo(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
