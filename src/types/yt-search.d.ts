declare module "yt-search" {
  export type VideoSearchResult = {
    type: "video";
    videoId: string;
    url: string;
    title: string;
    description?: string;
    thumbnail?: string;
    seconds?: number;
    timestamp?: string;
    duration?: { seconds: number; timestamp: string } | string | number;
    ago?: string;
    views?: number;
    author?: { name: string; url?: string } | string;
  };

  export type ChannelSearchResult = { type: "channel"; name: string; url: string };
  export type PlaylistSearchResult = { type: "list"; title: string; url: string; listId: string };

  export type SearchResults = {
    videos: VideoSearchResult[];
    channels: ChannelSearchResult[];
    playlists: PlaylistSearchResult[];
  };

  export type VideoLookup = {
    videoId: string;
    url: string;
    title: string;
    description?: string;
    thumbnail?: string;
    seconds?: number;
    timestamp?: string;
    duration?: { seconds: number; timestamp: string } | string | number;
    ago?: string;
    views?: number;
    author?: { name: string; url?: string } | string;
  };

  function ytSearch(query: string): Promise<SearchResults>;
  function ytSearch(opts: { query: string }): Promise<SearchResults>;
  function ytSearch(opts: { videoId: string }): Promise<VideoLookup | null>;
  function ytSearch(opts: { listId: string }): Promise<PlaylistSearchResult & { videos: VideoSearchResult[] }>;

  export default ytSearch;
}
