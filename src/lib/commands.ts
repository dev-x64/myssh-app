// Commands people type on servers all the time, offered while typing when
// neither history nor snippets have anything better.
//
// A command that ends with a space expects an argument: it is put on the
// line and the user carries on typing. Within a tool, the commonest come
// first; that is the order they are offered in.

export interface KnownCommand {
  command: string;
  en: string;
  ru: string;
}

const c = (command: string, en: string, ru: string): KnownCommand => ({ command, en, ru });

export const COMMANDS: KnownCommand[] = [
  // ---------------------------------------------------------------- files
  c("ls -la", "List files, hidden ones too", "Список файлов, включая скрытые"),
  c("ls -lah", "List files with readable sizes", "Список файлов с размерами"),
  c("ls -lt", "List files, newest first", "Список файлов, новые сверху"),
  c("cd ..", "Up one directory", "На каталог выше"),
  c("cd -", "Back to the previous directory", "В предыдущий каталог"),
  c("cd ~", "Home directory", "В домашний каталог"),
  c("pwd", "Where am I", "Текущий каталог"),
  c("mkdir -p ", "Create a directory with its parents", "Создать каталог вместе с родительскими"),
  c("rm -rf ", "Delete with everything inside, no questions", "Удалить со всем содержимым, без вопросов"),
  c("cp -r ", "Copy with everything inside", "Скопировать со всем содержимым"),
  c("mv ", "Move or rename", "Переместить или переименовать"),
  c("touch ", "Create an empty file", "Создать пустой файл"),
  c("cat ", "Print a file", "Показать файл"),
  c("less ", "Read a file page by page", "Читать файл постранично"),
  c("head -n 20 ", "First lines of a file", "Первые строки файла"),
  c("tail -n 100 ", "Last lines of a file", "Последние строки файла"),
  c("tail -f ", "Follow a file as it grows", "Следить за файлом"),
  c("tail -f /var/log/syslog", "Follow the system log", "Следить за системным журналом"),
  c("nano ", "Edit a file", "Редактировать файл"),
  c("vim ", "Edit a file", "Редактировать файл"),
  c("find . -name ", "Find files by name", "Найти файлы по имени"),
  c("find . -type f -mtime -1", "Files changed in the last day", "Файлы, изменённые за сутки"),
  c("grep -rn ", "Search text in files", "Искать текст в файлах"),
  c("grep -i ", "Search ignoring case", "Искать без учёта регистра"),
  c("chmod +x ", "Make a file executable", "Сделать файл исполняемым"),
  c("chmod 644 ", "Owner writes, others read", "Владелец пишет, остальные читают"),
  c("chmod -R 755 ", "Set permissions for a whole tree", "Права на всё дерево"),
  c("chown -R ", "Change the owner of a whole tree", "Сменить владельца всего дерева"),
  c("ln -s ", "Create a symbolic link", "Создать символическую ссылку"),
  c("tar -czf ", "Pack into a .tar.gz", "Упаковать в .tar.gz"),
  c("tar -xzf ", "Unpack a .tar.gz", "Распаковать .tar.gz"),
  c("unzip ", "Unpack a .zip", "Распаковать .zip"),
  c("zip -r ", "Pack into a .zip", "Упаковать в .zip"),
  c("wc -l ", "Count lines", "Посчитать строки"),
  c("diff ", "Compare two files", "Сравнить два файла"),
  c("stat ", "Details of a file", "Сведения о файле"),
  c("tree -L 2", "Directory tree, two levels deep", "Дерево каталогов на два уровня"),

  // ------------------------------------------------------ disk and memory
  c("df -h", "Free space on disks", "Свободное место на дисках"),
  c("df -i", "Free inodes", "Свободные inode"),
  c("du -sh *", "Size of everything here", "Размер всего в каталоге"),
  c("du -h --max-depth=1", "Size of subdirectories", "Размер подкаталогов"),
  c("lsblk", "Disks and partitions", "Диски и разделы"),
  c("free -h", "Memory in use", "Занятая память"),
  c("free -m", "Memory in megabytes", "Память в мегабайтах"),

  // --------------------------------------------------------------- system
  c("top", "Processes, live", "Процессы в реальном времени"),
  c("htop", "Processes, live and readable", "Процессы, наглядно"),
  c("uptime", "Uptime and load", "Время работы и нагрузка"),
  c("uname -a", "Kernel and architecture", "Ядро и архитектура"),
  c("cat /etc/os-release", "Which system this is", "Какая это система"),
  c("hostnamectl", "Host name and system", "Имя хоста и система"),
  c("hostname -I", "This machine's addresses", "Адреса этой машины"),
  c("nproc", "Number of CPU cores", "Число ядер процессора"),
  c("lscpu", "About the processor", "О процессоре"),
  c("vmstat 1", "Load, second by second", "Нагрузка по секундам"),
  c("iostat -x 1", "Disk load, second by second", "Нагрузка на диски по секундам"),
  c("dmesg -T | tail -n 50", "Latest kernel messages", "Последние сообщения ядра"),
  c("date", "Date and time", "Дата и время"),
  c("timedatectl", "Clock and time zone", "Часы и часовой пояс"),
  c("whoami", "Current user", "Текущий пользователь"),
  c("id", "User and groups", "Пользователь и группы"),
  c("w", "Who is logged in", "Кто в системе"),
  c("last -n 20", "Recent logins", "Последние входы"),
  c("env", "Environment variables", "Переменные окружения"),
  c("history | grep ", "Search command history", "Искать в истории команд"),
  c("which ", "Where a command lives", "Где лежит команда"),
  c("watch -n 1 ", "Repeat a command every second", "Повторять команду каждую секунду"),
  c("reboot", "Restart the machine", "Перезагрузить машину"),
  c("shutdown -h now", "Power off now", "Выключить сейчас"),
  c("sudo -i", "Become root", "Стать root"),
  c("sudo su -", "Become root", "Стать root"),
  c("passwd", "Change the password", "Сменить пароль"),
  c("adduser ", "Create a user", "Создать пользователя"),
  c("usermod -aG sudo ", "Let a user use sudo", "Разрешить пользователю sudo"),
  c("usermod -aG docker $USER", "Let yourself use Docker", "Разрешить себе Docker"),
  c("crontab -e", "Edit scheduled jobs", "Редактировать расписание"),
  c("crontab -l", "Show scheduled jobs", "Показать расписание"),

  // ------------------------------------------------------------ processes
  c("ps aux", "All processes", "Все процессы"),
  c("ps aux | grep ", "Find a process", "Найти процесс"),
  c("kill ", "Ask a process to stop", "Попросить процесс завершиться"),
  c("kill -9 ", "Kill a process at once", "Убить процесс сразу"),
  c("killall ", "Stop processes by name", "Завершить процессы по имени"),
  c("pkill -f ", "Stop processes by command line", "Завершить процессы по командной строке"),
  c("pgrep -af ", "Find processes by command line", "Найти процессы по командной строке"),
  c("lsof -i :", "Who holds a port", "Кто занимает порт"),

  // ------------------------------------------------------------- services
  c("systemctl status ", "State of a service", "Состояние службы"),
  c("systemctl restart ", "Restart a service", "Перезапустить службу"),
  c("systemctl start ", "Start a service", "Запустить службу"),
  c("systemctl stop ", "Stop a service", "Остановить службу"),
  c("systemctl reload ", "Reload a service's config", "Перечитать конфигурацию службы"),
  c("systemctl enable --now ", "Start a service now and at boot", "Запустить службу и включить автозапуск"),
  c("systemctl disable ", "Do not start a service at boot", "Выключить автозапуск службы"),
  c("systemctl daemon-reload", "Reread unit files", "Перечитать файлы служб"),
  c("systemctl --failed", "Services that failed", "Службы с ошибками"),
  c("systemctl list-units --type=service --state=running", "Running services", "Работающие службы"),
  c("journalctl -u ", "Log of a service", "Журнал службы"),
  c("journalctl -fu ", "Follow the log of a service", "Следить за журналом службы"),
  c("journalctl -xe", "Latest log entries, explained", "Последние записи журнала с пояснениями"),
  c("journalctl -p err -b", "Errors since boot", "Ошибки с момента загрузки"),
  c("journalctl --since \"1 hour ago\"", "Log of the last hour", "Журнал за последний час"),

  // -------------------------------------------------------------- network
  c("ip a", "Network interfaces and addresses", "Сетевые интерфейсы и адреса"),
  c("ip r", "Routes", "Маршруты"),
  c("ss -tulpn", "Listening ports and who owns them", "Открытые порты и кто их слушает"),
  c("netstat -tulpn", "Listening ports and who owns them", "Открытые порты и кто их слушает"),
  c("ping -c 4 ", "Check that a host answers", "Проверить, отвечает ли хост"),
  c("curl -I ", "Response headers of a URL", "Заголовки ответа по адресу"),
  c("curl -fsSL ", "Download quietly, fail on errors", "Скачать тихо, с ошибкой при сбое"),
  c("curl ifconfig.me", "This machine's public address", "Внешний адрес этой машины"),
  c("wget ", "Download a file", "Скачать файл"),
  c("dig ", "Look a name up in DNS", "Запрос к DNS"),
  c("nslookup ", "Look a name up in DNS", "Запрос к DNS"),
  c("traceroute ", "The path to a host", "Путь до хоста"),
  c("nc -zv ", "Check that a port is open", "Проверить, открыт ли порт"),
  c("ufw status", "Firewall rules", "Правила файрвола"),
  c("ufw allow ", "Open a port in the firewall", "Открыть порт в файрволе"),
  c("ufw enable", "Turn the firewall on", "Включить файрвол"),
  c("iptables -L -n -v", "Firewall rules, in full", "Правила файрвола, подробно"),
  c("scp ", "Copy files over SSH", "Скопировать файлы по SSH"),
  c("rsync -avz ", "Synchronise directories", "Синхронизировать каталоги"),
  c("ssh-keygen -t ed25519", "Create an SSH key", "Создать SSH-ключ"),
  c("ssh-copy-id ", "Install your key on a server", "Установить свой ключ на сервер"),
  c("cat ~/.ssh/authorized_keys", "Keys allowed to sign in here", "Ключи, которым разрешён вход"),

  // ------------------------------------------------------------- packages
  c("apt update", "Refresh the package lists", "Обновить списки пакетов"),
  c("apt upgrade -y", "Install available updates", "Установить обновления"),
  c("apt update && apt upgrade -y", "Refresh and update everything", "Обновить списки и всё установить"),
  c("apt install -y ", "Install a package", "Установить пакет"),
  c("apt remove ", "Remove a package", "Удалить пакет"),
  c("apt autoremove -y", "Remove packages no longer needed", "Удалить ненужные пакеты"),
  c("apt search ", "Search for a package", "Найти пакет"),
  c("apt list --upgradable", "What can be updated", "Что можно обновить"),
  c("dnf install -y ", "Install a package", "Установить пакет"),
  c("dnf update -y", "Install available updates", "Установить обновления"),
  c("yum install -y ", "Install a package", "Установить пакет"),
  c("yum update -y", "Install available updates", "Установить обновления"),
  c("apk add ", "Install a package", "Установить пакет"),
  c("apk update", "Refresh the package lists", "Обновить списки пакетов"),
  c("snap install ", "Install a snap", "Установить snap"),
  c("pip install -r requirements.txt", "Install Python dependencies", "Установить зависимости Python"),
  c("pip install ", "Install a Python package", "Установить пакет Python"),
  c("python3 -m venv .venv", "Create a virtual environment", "Создать виртуальное окружение"),
  c("source .venv/bin/activate", "Enter the virtual environment", "Войти в виртуальное окружение"),
  c("npm install", "Install Node dependencies", "Установить зависимости Node"),
  c("npm ci", "Install exactly what the lock file says", "Установить зависимости по lock-файлу"),
  c("npm run build", "Build the project", "Собрать проект"),
  c("pm2 list", "Processes under pm2", "Процессы под pm2"),
  c("pm2 logs", "Logs of pm2 processes", "Журналы процессов pm2"),
  c("pm2 restart ", "Restart a pm2 process", "Перезапустить процесс pm2"),

  // --------------------------------------------------------------- docker
  c("docker ps", "Running containers", "Работающие контейнеры"),
  c("docker ps -a", "All containers", "Все контейнеры"),
  c("docker compose up -d", "Start the services in the background", "Запустить сервисы в фоне"),
  c("docker compose up -d --build", "Rebuild and start in the background", "Пересобрать и запустить в фоне"),
  c("docker compose down", "Stop and remove the services", "Остановить и удалить сервисы"),
  c("docker compose logs -f", "Follow the services' logs", "Следить за журналами сервисов"),
  c("docker compose logs -f --tail 100", "Follow the logs from the last 100 lines", "Журналы с последних 100 строк"),
  c("docker compose ps", "State of the services", "Состояние сервисов"),
  c("docker compose pull", "Fetch newer images", "Скачать свежие образы"),
  c("docker compose restart", "Restart the services", "Перезапустить сервисы"),
  c("docker compose build", "Build the images", "Собрать образы"),
  c("docker compose up --build", "Rebuild and start in the foreground", "Пересобрать и запустить на переднем плане"),
  c("docker compose exec ", "Run a command in a service", "Выполнить команду в сервисе"),
  c("docker compose stop", "Stop the services", "Остановить сервисы"),
  c("docker compose config", "The resulting configuration", "Итоговая конфигурация"),
  c("docker logs -f ", "Follow a container's log", "Следить за журналом контейнера"),
  c("docker logs --tail 100 ", "Last lines of a container's log", "Последние строки журнала контейнера"),
  c("docker exec -it ", "Run a command in a container", "Выполнить команду в контейнере"),
  c("docker images", "Images on this machine", "Образы на этой машине"),
  c("docker stats", "Resources used by containers", "Ресурсы, занятые контейнерами"),
  c("docker restart ", "Restart a container", "Перезапустить контейнер"),
  c("docker stop ", "Stop a container", "Остановить контейнер"),
  c("docker start ", "Start a container", "Запустить контейнер"),
  c("docker rm ", "Remove a container", "Удалить контейнер"),
  c("docker rmi ", "Remove an image", "Удалить образ"),
  c("docker pull ", "Fetch an image", "Скачать образ"),
  c("docker build -t ", "Build an image", "Собрать образ"),
  c("docker run -d ", "Start a container in the background", "Запустить контейнер в фоне"),
  c("docker run --rm -it ", "Run a throwaway container", "Запустить одноразовый контейнер"),
  c("docker inspect ", "Everything about a container", "Всё о контейнере"),
  c("docker network ls", "Docker networks", "Сети Docker"),
  c("docker volume ls", "Docker volumes", "Тома Docker"),
  c("docker system df", "Space taken by Docker", "Место, занятое Docker"),
  c("docker system prune -af", "Remove everything unused", "Удалить всё неиспользуемое"),
  c("docker-compose up -d", "Start the services in the background", "Запустить сервисы в фоне"),
  c("docker-compose down", "Stop and remove the services", "Остановить и удалить сервисы"),
  c("docker-compose logs -f", "Follow the services' logs", "Следить за журналами сервисов"),

  // ------------------------------------------------------------------ git
  c("git status", "What has changed", "Что изменилось"),
  c("git pull", "Fetch and merge", "Получить и слить изменения"),
  c("git push", "Send commits", "Отправить коммиты"),
  c("git log --oneline -n 20", "Recent commits, one per line", "Последние коммиты, по строке на каждый"),
  c("git diff", "Changes not yet staged", "Неподготовленные изменения"),
  c("git fetch", "Fetch without merging", "Получить без слияния"),
  c("git add .", "Stage everything", "Подготовить все изменения"),
  c("git commit -m ", "Commit with a message", "Коммит с сообщением"),
  c("git checkout ", "Switch branch or restore a file", "Переключить ветку или вернуть файл"),
  c("git checkout -b ", "Create a branch and switch to it", "Создать ветку и перейти на неё"),
  c("git branch -a", "All branches", "Все ветки"),
  c("git stash", "Put changes aside", "Отложить изменения"),
  c("git stash pop", "Bring changes back", "Вернуть отложенные изменения"),
  c("git clone ", "Clone a repository", "Клонировать репозиторий"),
  c("git reset --hard", "Discard all local changes", "Отбросить все локальные изменения"),
  c("git remote -v", "Where the repository points", "Куда смотрит репозиторий"),

  // ------------------------------------------------- web, databases, more
  c("nginx -t", "Check the nginx configuration", "Проверить конфигурацию nginx"),
  c("nginx -s reload", "Reload nginx", "Перечитать конфигурацию nginx"),
  c("systemctl reload nginx", "Reload nginx", "Перечитать конфигурацию nginx"),
  c("systemctl restart nginx", "Restart nginx", "Перезапустить nginx"),
  c("certbot renew", "Renew certificates", "Продлить сертификаты"),
  c("certbot --nginx", "Get a certificate for nginx", "Получить сертификат для nginx"),
  c("mysql -u root -p", "MySQL console", "Консоль MySQL"),
  c("psql -U postgres", "PostgreSQL console", "Консоль PostgreSQL"),
  c("redis-cli", "Redis console", "Консоль Redis"),
  c("tmux ls", "tmux sessions", "Сессии tmux"),
  c("tmux attach", "Return to a tmux session", "Вернуться в сессию tmux"),
  c("tmux new -s ", "New named tmux session", "Новая именованная сессия tmux"),
  c("screen -ls", "screen sessions", "Сессии screen"),
  c("screen -r", "Return to a screen session", "Вернуться в сессию screen"),
  c("kubectl get pods", "Pods in this namespace", "Поды в этом пространстве имён"),
  c("kubectl get pods -A", "Pods in all namespaces", "Поды во всех пространствах имён"),
  c("kubectl get nodes", "Cluster nodes", "Узлы кластера"),
  c("kubectl logs -f ", "Follow a pod's log", "Следить за журналом пода"),
  c("kubectl describe pod ", "Everything about a pod", "Всё о поде"),
  c("kubectl apply -f ", "Apply a manifest", "Применить манифест"),
];

/**
 * Other command names that are real, so that typing one is never taken for
 * a slip of the finger.
 */
export const OTHER_NAMES = new Set(
  (
    "sudo su ssh sftp ftp telnet man info help echo printf read test true false exit logout clear reset " +
    "alias unalias export unset set source bash sh zsh fish dash ksh csh tcsh exec eval time sleep wait jobs " +
    "fg bg disown nohup nice renice xargs tee sed awk gawk cut tr sort uniq rev tac nl paste join comm column " +
    "fold fmt split shuf seq yes expr bc dc jq yq xxd od hexdump strings base64 md5sum sha1sum sha256sum " +
    "cksum openssl gpg ll la l dir vdir more most bat rg ag fd fzf locate updatedb whereis type command " +
    "basename dirname realpath readlink mktemp dd sync truncate shred rmdir install rename file lsattr chattr " +
    "chgrp umask getfacl setfacl gzip gunzip zcat bzip2 bunzip2 xz unxz zstd 7z rar unrar cpio ar " +
    "mount umount fdisk parted mkfs fsck blkid findmnt swapon swapoff ncdu iotop iftop nload nethogs glances " +
    "btop atop sar mpstat pidstat strace ltrace gdb perf lsmod modprobe rmmod insmod sysctl ulimit " +
    "service chkconfig update-rc.d init telinit halt poweroff loginctl localectl resolvectl networkctl " +
    "ifconfig route arp iwconfig nmcli nmtui ethtool tcpdump nmap mtr host whois socat ncat netcat ab wrk " +
    "http httpie aria2c lftp " +
    "apt-get apt-cache dpkg dpkg-query add-apt-repository zypper pacman yay brew port pkg rpm flatpak " +
    "pip3 pipx python python2 python3 poetry uv conda virtualenv node nodejs npx yarn pnpm bun deno nvm " +
    "ruby gem bundle rake rails php composer artisan java javac mvn gradle go cargo rustc rustup gcc g++ " +
    "cc make cmake ninja perl lua dotnet " +
    "podman buildah skopeo ctr crictl nerdctl helm k9s minikube kind k3s kubeadm kubelet terraform ansible " +
    "ansible-playbook vagrant packer aws gcloud az doctl flyctl heroku vercel netlify gh hub svn hg " +
    "mysqldump mysqladmin mariadb pg_dump pg_restore pg_ctl createdb dropdb sqlite3 mongo mongosh " +
    "mongodump redis-server memcached " +
    "apache2 apache2ctl apachectl httpd caddy haproxy traefik php-fpm supervisorctl supervisord " +
    "fail2ban-client logrotate cron at batch anacron " +
    "useradd userdel groupadd groupdel gpasswd chpasswd chage visudo groups users who finger lastlog " +
    "vi nvim emacs micro ed joe pico code " +
    "cal ncal bc units factor uname arch lsb_release lsusb lspci lshw dmidecode sensors hdparm smartctl " +
    "df du ls cd"
  ).split(" "),
);

/**
 * Further words that are valid after a tool's name, beyond those the
 * commands above use.
 */
export const OTHER_SUBCOMMANDS: Record<string, string[]> = {
  docker: (
    "attach commit container context cp create diff events export history image import info kill load login " +
    "logout manifest network node pause plugin port push rename save search secret service stack swarm " +
    "system tag top trust unpause update version volume wait buildx builder"
  ).split(" "),
  "docker compose": (
    "attach cp create events images kill ls pause port push rm run scale start top unpause version wait watch"
  ).split(" "),
  "docker-compose": (
    "build config create events exec images kill pause port ps pull push restart rm run start stop top " +
    "unpause version"
  ).split(" "),
  git: (
    "am apply archive bisect blame bundle cherry-pick clean config describe gc grep init merge mv notes " +
    "rebase reflog restore revert rm shortlog show switch tag worktree submodule ls-files rev-parse"
  ).split(" "),
  systemctl: (
    "cat edit show mask unmask is-active is-enabled is-failed list-unit-files list-timers list-sockets " +
    "kill isolate reboot poweroff suspend hibernate try-restart reload-or-restart reenable preset " +
    "set-default get-default"
  ).split(" "),
  apt: "show purge policy depends rdepends full-upgrade dist-upgrade autoclean clean edit-sources reinstall".split(
    " ",
  ),
  dnf: "remove search info list upgrade autoremove clean repolist history group module".split(" "),
  yum: "remove search info list upgrade autoremove clean repolist history group".split(" "),
  apk: "del search info upgrade fix list cache".split(" "),
  npm: "start test publish init update uninstall outdated audit link ls exec login version cache".split(" "),
  pm2: "start stop delete reload status monit save startup show describe flush".split(" "),
  kubectl: (
    "create delete edit exec explain expose rollout scale set top port-forward config cluster-info " +
    "version label annotate patch cp drain cordon uncordon taint"
  ).split(" "),
  ufw: "deny delete disable reload reset logging limit reject app".split(" "),
  certbot: "certonly certificates delete revoke".split(" "),
  tmux: "kill-session kill-server list-sessions new-session rename-session detach a".split(" "),
  ip: "addr address link route neigh rule netns l n".split(" "),
  // `ps -aux` works too; it is not a slip.
  ps: ["-aux", "-ef", "auxf", "-eo"],
};
