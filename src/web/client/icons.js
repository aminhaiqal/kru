import {
  GithubIcon,
  Globe02Icon,
  Upload01Icon,
  Folder01Icon,
  File01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowDown01Icon,
  PencilEdit02Icon,
  Delete02Icon,
  RefreshIcon,
  Cancel01Icon,
  Add01Icon,
  StopIcon,
  Sun03Icon,
  Moon02Icon,
  ComputerIcon,
  Tick02Icon,
  PanelLeftIcon,
} from '@hugeicons/core-free-icons';
import { escape } from './dom.js';

const render = (icon) => {
  const paths = icon
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .filter(([key]) => key !== 'key')
          .map(
            ([key, value]) =>
              `${key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())}="${escape(String(value))}"`,
          )
          .join(' ')} />`,
    )
    .join('');
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${paths}</svg>`;
};

export const chatGlobeIcon = render(Globe02Icon);
export const chatUploadIcon = render(Upload01Icon);
export const chatFolderIcon = render(Folder01Icon);
export const chatFileIcon = render(File01Icon);
export const browserBackIcon = render(ArrowLeft01Icon);
export const browserForwardIcon = render(ArrowRight01Icon);
export const browserReloadIcon = render(RefreshIcon);
export const browserCloseIcon = render(Cancel01Icon);
export const browserAddIcon = render(Add01Icon);
export const browserStopIcon = render(StopIcon);
export const themeLightIcon = render(Sun03Icon);
export const themeDarkIcon = render(Moon02Icon);
export const themeSystemIcon = render(ComputerIcon);
export const themeCheckIcon = render(Tick02Icon);
export const chatSidebarIcon = render(PanelLeftIcon);
export const chatModelChevronIcon = render(ArrowDown01Icon);
export const chatRenameIcon = render(PencilEdit02Icon);
export const chatTrashIcon = render(Delete02Icon);

export const githubIcon = render(GithubIcon);
