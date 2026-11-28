# Darkys Launcher Privacy Policy

**Effective date: 28 November 2026**  
**Project:** Darkys Launcher  
**Source code:** https://github.com/DarkBlockWizard/Darkys-Launcher  
**Contact:** darkyslauncheroffical@gmail.com

Darkys Launcher is an independently developed, open-source desktop application for Minecraft: Java Edition. This policy explains what information the application stores locally and what information may be sent to third-party services when you use its features.

Darkys Launcher is not developed, operated, endorsed, or supported by Mojang or Microsoft.

## 1. Information stored on your device

Depending on the features you use, Darkys Launcher stores the following information locally on your device:

- **Local profile information:** an offline profile name and locally generated player identifier, or the Minecraft profile name, UUID, skin URL, and skin model returned during Microsoft/Minecraft sign-in.
- **Authentication token:** when you sign in with Microsoft, the application stores a Microsoft/Xbox refresh token so that you do not need to sign in every time. The token is encrypted using Electron `safeStorage` before it is saved. The application does not intentionally store your Microsoft account password.
- **Launcher settings:** RAM limits, a custom Java path, automatic server connection preference and server address, and other launcher preferences.
- **CurseForge API key:** only if you choose to enter one. The key is encrypted with Electron `safeStorage` before it is stored locally.
- **Minecraft data:** downloaded game versions, libraries, assets, modpacks, mods, resource packs, shader packs, and related metadata are stored in the launcher's local application-data and instance folders.
- **Skin files:** a skin image you select is copied to a local application-data folder so the launcher can use it.
- **Diagnostic log:** the launcher writes a local startup log when startup or renderer errors occur. It may contain timestamps, error messages, stack traces, and local file paths.

On Windows, the application data directory is configured under the current user's application-data directory (normally `%APPDATA%\\darkys-launcher`). These files are not automatically uploaded to Darkys Launcher maintainers.

## 2. Information sent to third-party services

Darkys Launcher does not operate a central account server. It communicates directly with third-party services when the application needs data for a feature or when you choose that feature. Those services may receive your IP address, request metadata, and information necessary to provide the requested service, as is normal for network requests.

The application may communicate with the following services:

- **Microsoft, Xbox, and Minecraft Services:** when you choose Microsoft sign-in, the authentication flow communicates with Microsoft/Xbox/Minecraft services to authenticate your account, verify Minecraft Java entitlement, and retrieve your Minecraft profile. When you use a saved Microsoft session, the application may refresh authentication tokens with those services. Your Microsoft password is entered into the Microsoft sign-in flow, not intentionally stored by Darkys Launcher.
- **Mojang/Minecraft services:** the launcher checks the official Minecraft version manifest and obtains Minecraft version metadata and game files needed to install or launch the game. The version manifest is refreshed when the launcher starts and periodically while it remains open.
- **Fabric, Minecraft Forge, and NeoForged:** the launcher requests loader version information and downloads loader components needed for the selected Minecraft profile.
- **Eclipse Adoptium:** when a compatible Java runtime is requested through the launcher, it may query Adoptium metadata and download the selected runtime.
- **Modrinth:** when you search for, install, or import Modrinth content, the launcher sends the relevant search or project/version requests and downloads the files referenced by the Modrinth project or modpack metadata.
- **CurseForge:** when you select CurseForge features, requests are sent to the CurseForge API using the API key you supplied. CurseForge access may not work unless you provide a valid key. Darkys Launcher does not provide a shared maintainer API key in the application.
- **Minecraft Services skin endpoint:** if you are signed in with a licensed Microsoft/Minecraft account and choose to upload a skin, the selected PNG skin file is sent to Minecraft Services. For a local/offline profile, the selected skin remains local and is not uploaded by the launcher.
- **Google Fonts:** the interface stylesheet requests the Nunito font from Google Fonts. When the font is requested, Google may receive standard connection information such as your IP address and browser request metadata. The font is used to render the launcher interface.

The launcher may also download files from the file hosts specified by official Minecraft, loader, Modrinth, or CurseForge metadata. The exact download host depends on the file and the provider's current distribution links.

When you launch Minecraft and connect to a multiplayer server, Minecraft itself connects to the server you selected. That server may receive your IP address, Minecraft player identity, and normal game-protocol information. This is controlled by Minecraft and the server, not by a Darkys-operated server.

## 3. Analytics, advertising, and telemetry

The reviewed Darkys Launcher application code does not implement a Darkys-operated analytics, advertising, telemetry, or remote crash-reporting service. Startup diagnostic logs are written locally and are not automatically sent to the project maintainer.

This statement does not cover data processing performed independently by Microsoft, Google, Mojang/Minecraft, Modrinth, CurseForge, loader projects, download hosts, or multiplayer servers. Their own privacy policies and terms apply when you use their services.

## 4. Your choices

- You can use a local/offline profile instead of signing in with Microsoft. An offline profile does not provide a Minecraft license or grant access to online services that require a licensed account.
- You can choose whether to use Modrinth or CurseForge features. CurseForge features require a key supplied by you.
- Skin upload to Minecraft Services occurs only when you choose a skin while signed in with a Microsoft/Minecraft account. A skin selected under a local/offline profile is kept locally.
- You can sign out from the launcher. The sign-out feature removes the saved profile and saved Microsoft refresh token from the launcher's local store.
- You can uninstall the application. Minecraft instances, worlds, downloaded content, and application data may remain in your user-data folder so that uninstalling the program does not unexpectedly delete user-created game data. You can remove remaining application data manually after backing up anything you want to keep.

Some network access is necessary for account authentication, Minecraft version metadata, game/runtime downloads, mod discovery, and other online features. The application does not currently provide a single global switch that disables all network requests while keeping those online features available.

## 5. Data retention and security

Local profile information, settings, tokens, caches, game files, and logs remain on your device until removed by the application, overwritten, or deleted by you. Microsoft refresh tokens and the optional CurseForge API key are encrypted with Electron `safeStorage`; the actual protection depends on the operating system's available secure-storage mechanism and your device account security.

No storage method is guaranteed to be perfectly secure. Keep your operating system and device protected, and do not share your application-data folder or diagnostic logs if they contain information you consider private.

## 6. Children's privacy

Darkys Launcher is a general-purpose game launcher and is not designed to collect personal information from children. Microsoft account sign-in and Minecraft use are subject to the age, family, and account requirements imposed by Microsoft and the relevant services. Parents or guardians should supervise children's use of online accounts and multiplayer servers.

## 7. Third-party services

Your use of third-party services is also governed by their own terms and privacy policies. Relevant providers include:

- Microsoft Privacy Statement: https://privacy.microsoft.com/privacystatement
- Google Privacy Policy: https://policies.google.com/privacy
- Modrinth: https://modrinth.com/legal/privacy
- CurseForge: https://www.curseforge.com/privacy-policy
- Eclipse Adoptium: https://adoptium.net/terms-of-use
- Minecraft/Mojang: https://www.minecraft.net/en-us/privacystatement

The availability and terms of third-party services may change independently of Darkys Launcher.

## 8. Changes to this policy

This policy may be updated when the launcher's features, dependencies, or data flows change. The current version is published in the project's public GitHub repository. The effective date at the top indicates the latest revision date.

## 9. Contact

For privacy questions about Darkys Launcher, contact **darkyslauncheroffical@gmail.com** or open an issue in the public repository:

https://github.com/DarkBlockWizard/Darkys-Launcher/issues
