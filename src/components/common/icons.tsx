import {
  Archive,
  AudioLines,
  Bell,
  Binary,
  Clock,
  Code2,
  File,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Grid3x3,
  Home,
  Image,
  Info,
  Layers,
  Lock,
  Monitor,
  Package,
  Play,
  Settings,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { FileKind } from '../../lib/types';

export const COMPONENT_ICONS: Record<string, LucideIcon> = {
  metadata: Info,
  previews: Monitor,
  wallpapers: Image,
  lockscreen: Lock,
  icons: Grid3x3,
  systemui: Bell,
  framework: Layers,
  settings: Settings,
  home: Home,
  apps: Package,
  fonts: Type,
  sounds: AudioLines,
  boot: Play,
  widgets: Clock,
  other: Folder,
};

export function componentIcon(id: string): LucideIcon {
  return COMPONENT_ICONS[id] ?? Folder;
}

export function kindIcon(kind: FileKind): LucideIcon {
  switch (kind) {
    case 'image':
      return FileImage;
    case 'xml':
      return FileCode2;
    case 'text':
      return FileText;
    case 'font':
      return Type;
    case 'audio':
      return AudioLines;
    case 'video':
      return FileVideo;
    case 'archive':
      return Archive;
    case 'binaryXml':
      return Code2;
    case 'binary':
      return Binary;
    default:
      return File;
  }
}
