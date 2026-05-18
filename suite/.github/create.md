Usage: C:\users\butch\ModusToolbox\tools_3.7\project-creator\project-creator-cli.exe [options]
The Project Creator is a stand-alone tool provided with the ModusToolbox software. It creates a new project for a combination of a template application and a board support package (BSP) by either cloning them from a remote server onto your computer running a "git clone" command or importing them from a local disk.

The minimum required arguments for the clone mode of this tool are --board-id (or -b), which refers to the BSP ID in the manifest, and --app-id (or -a), which refers to the application. The following two examples will clone a Hello World application configured for CY8CKIT-062-WIFI-BT BSP into your <current working directory>:
        project-creator-cli --board-id CY8CKIT-062-WIFI-BT --app-id mtb-example-hal-hello-world
        project-creator-cli -b CY8CKIT-062-WIFI-BT -a mtb-example-hal-hello-world

The minimum required arguments for the import mode of this tool are --board-path, which refers to the BSP location, and --app-path, which refers to the application location. The following example will copy a custom application configured for a custom target BSP into your <current working directory>:
        project-creator-cli --board-path <path/to/custom/target/BSP> --app-path <path/to/custom/application>

The Project Creator can combine import and clone operations for a BSP and a template application, but it cannot use --board-id (or -b) and --board-path at the same time, and it cannot use --app-id (or -a) and --app-path at the same time. The following example will copy a custom application and clone the CY8CKIT-062-WIFI-BT BSP into your <current working directory>:
        project-creator-cli -b CY8CKIT-062-WIFI-BT --app-path <path/to/custom/application>

The options --list-boards and --list-apps show available BSPs and template applications, respectively.

Use the --target-dir option to specify the directory in which to clone the application other than <current working directory> default (optional).

Use the --user-app-name option to specify the name of the application other than the template's default name (optional).

Options:
  -?, -h, --help                       Displays help on commandline options.
  --help-all                           Displays help, including generic Qt
                                       options.
  -v, --version                        Displays version information.
  --app-commit <Commit>                (Optional) Version of the application
                                       template set by --app-id. Should be used
                                       with --app-id and --app-uri only.
  -a, --app-id <ID>                    ID of the template application to clone.
                                       Cannot be used with --app-path.
  --app-path <PATH>                    Path of the custom application template
                                       to copy. Cannot be used with -a or
                                       --app-id.
  --app-uri <URI>                      (Optional) URI of the application
                                       template set by --app-id. Should be used
                                       with --app-id and --app-commit only.
  --board-commit <Commit>              (Optional) Version of the BSP set by
                                       --board-id. Should be used with
                                       --board-id and --board-uri only.
  -b, --board-id <ID>                  ID of the BSP to target. Cannot be used
                                       with --board-path.
  --board-path <PATH>                  Path of the custom BSP to copy. Cannot
                                       be used with -b or --board-id.
  --board-uri <URI>                    (Optional) URI of the BSP set by
                                       --board-id. Should be used with
                                       --board-id and --board-commit only.
  --list-apps <Board ID>               Lists IDs of all available template
                                       applications for the given BSP.
  --list-boards                        Lists IDs of all BSPs for which template
                                       applications are available.
  --list-sdk-id-version-pairs          Lists all SDK ID:version pairs.
  --list-sdk-ids                       Lists all SDK IDs.
  --list-sdk-versions-for-id <SDK ID>  Lists SDK Verions for the given SDK ID.
  --sdk-id <SDK ID>                    (Optional) SDK ID. Should be used with
                                       --sdk-version.
  --sdk-version <SDK version>          (Optional) SDK version. Should be used
                                       with --sdk-id.
  -d, --target-dir <DIR>               (Optional) Target directory in which to
                                       create the project. Default: Current
                                       working directory
  --use-modus-shell                    (Optional) If set, this tool uses
                                       binaries in modus-shell/bin, like git,
                                       make instead of ones in your PATH
                                       environment.
  -n, --user-app-name <NAME>           (Optional) User-defined application
                                       name. Default: Template application name
  --verbose <Level (0-3)>              (Optional) Displays more or less
                                       information in the proj