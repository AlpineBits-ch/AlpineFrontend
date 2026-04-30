export interface ToastConfig {
  title: string;
  body?: string;
  avatarUrl?: string;
  avatarLabel?: string;
  duration?: number;        // ms; 0 = sticky; default 5000
  sound?: boolean | string; // false | true (chime) | audio file URL
  onClick?: () => void;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  avatarUrl?: string;
  avatarLabel?: string;
  duration: number;
  sound: boolean | string;
  onClick?: () => void;
  leaving: boolean;
}
