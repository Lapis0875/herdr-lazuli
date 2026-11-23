// lazuli: one mod, one view per place it shows, chosen by `props().view` (ARCHITECTURE §2). Every copy
// loads the settings, runs its view, and pumps its key commands through the bus, which lets only the
// command's owner act. A view is a class: `new View(name)`, then init(props, cx), render(cx), and
// optionally close(cx), command(command, cx), key(event, cx), focus(cx) (see views/placeholder.js).

import { View } from "gpui-kit";
import { props, nextCommand } from "herdr";
import { dispatch } from "./sys/bus.js";
import { loadSettings } from "./sys/store.js";
import Brand from "./views/brand.js";
import Sidebar from "./views/sidebar.js";
import Bell from "./views/bell.js";
import Status from "./views/status.js";
import Activity from "./views/activity.js";
import PaneHead from "./views/pane-head.js";
import AgentHead from "./views/agent-head.js";
import Palette from "./views/palette.js";
import QuickOpen from "./views/quickopen.js";
import Settings from "./views/settings.js";
import Menu from "./views/menu.js";
import Home from "./views/home.js";
import Inbox from "./views/inbox.js";
import Todo from "./views/todo.js";
import Routines from "./views/routines.js";
import Queue from "./views/queue.js";
import Recap from "./views/recap.js";
import Review from "./views/review.js";
import FilesTree from "./views/files-tree.js";
import Tree from "./views/tree.js";
import Run from "./views/run.js";
import Transcript from "./views/transcript.js";
import FileTab from "./file/file-tab.js";
import Gallery from "./views/gallery.js";
import Assistant from "./views/assistant.js";
import AssistantList from "./views/assistant-list.js";
import AssistantInfo from "./views/assistant-info.js";
import Placeholder from "./views/placeholder.js";

/** Every view by its `view` prop. */
export const VIEWS = Object.freeze({
  brand: Brand,
  sidebar: Sidebar,
  bell: Bell,
  status: Status,
  activity: Activity,
  "pane-head": PaneHead,
  "agent-head": AgentHead,
  palette: Palette,
  quickopen: QuickOpen,
  settings: Settings,
  menu: Menu,
  home: Home,
  inbox: Inbox,
  todo: Todo,
  routines: Routines,
  queue: Queue,
  recap: Recap,
  review: Review,
  files: FilesTree,
  tree: Tree,
  run: Run,
  transcript: Transcript,
  file: FileTab,
  gallery: Gallery,
  assistant: Assistant,
  "assistant-list": AssistantList,
  "assistant-info": AssistantInfo,
  placeholder: Placeholder,
});

export default class Lazuli extends View {
  init(p, cx) {
    this.props = p ?? props() ?? {};
    this.name = typeof this.props.view === "string" ? this.props.view : "";
    const Impl = Object.prototype.hasOwnProperty.call(VIEWS, this.name) ? VIEWS[this.name] : Placeholder;
    this.impl = new Impl(this.name);
    loadSettings();
    this.impl.init?.(this.props, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        dispatch(command, this, cx);
        cx.notify();
      }
    });
  }

  render(cx) {
    return this.impl.render(cx);
  }

  async close(cx) {
    await this.impl.close?.(cx);
  }
}
