# Install and open a workspace

1. Download Minnow from [GitHub Releases](https://github.com/HenriGrimm/Minnow/releases). On Windows, run the Setup `.exe`. On macOS, choose the DMG for your Mac's architecture and drag Minnow into Applications. On Linux, download the AppImage for your architecture, make it executable, and launch it.
2. On the setup screen, choose how to [connect a model](connect-a-model.md). Select **Restore from a backup** if you are moving an existing profile.
3. In the workspace picker, open the folder that contains your project files. Select **Sandbox** if you want to try Minnow with an empty folder. Code opens after you choose a workspace.

To relocate an existing project, close it and select **Move project** on its row in the workspace picker. Choose an existing destination folder on the same drive, then confirm. Minnow moves the entire project folder, including uncommitted and ignored files, and keeps its chats, chat groups, issues, and project memory. Open the project again from its new location in the list.

Minnow does not replace an existing folder. Stop running work before moving. Projects with linked Git worktrees or automations that still point at the project cannot be moved with this action.

If you downloaded an unsigned Windows build and Windows shows **More info**, verify the source and file before choosing **Run anyway**. On macOS, follow the release notes for the specific build if macOS blocks opening it.

## Keep work running or quit

Closing the desktop window normally leaves Minnow running in the system tray. To shut down the tool server, chats, and automations, choose **Quit Minnow** from the tray. To change what the close button does, search **Keep Minnow running** in Settings.

Use **Settings → General → Updates** to check the installed version, select the Stable or Beta channel, or check for updates. Restart when Minnow shows an update is ready.

Continue with [Connect a model](connect-a-model.md) and [Make and review your first change](first-chat.md).
