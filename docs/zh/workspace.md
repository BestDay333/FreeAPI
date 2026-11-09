# 本地工作区

工作区命令会在运行 FreeAPI 服务的同一台电脑上执行。如果 FreeAPI 在用户自己的电脑上运行，就不需要使用 VDS。

## 安装

Arch Linux / CachyOS：

```bash
sudo pacman -S bubblewrap util-linux
npm run workspace:check
```

Bubblewrap 会创建隔离的 Linux namespace。只有当前对话的工作区可写；系统软件只读挂载。用户主目录、`/mnt`、Docker socket 和其他主机文件不会挂载到命令环境中。

## 文件

每个对话都有独立的本地目录，位于 `data/workspaces/`。FreeAPI 重启后文件仍然保留，并且不会提交到 Git。

聊天界面提供文件下载入口。专用下载器只允许公开 HTTP(S) 地址，并阻止 localhost 和私有网络地址。

## 命令和网络

Shell 命令在 Linux namespace 中运行。命令的网络访问默认关闭；只有任务需要安装依赖或从 Git 下载代码时才启用。`workspace_download` 工具可以单独下载公开 HTTP(S) 文件。

命令有运行时间、CPU 时间、进程数、文件大小和输出量限制。执行环境无法访问用户主目录或其他主机文件。

## 验证

```bash
npm run workspace:check
npm test
```

成功时会显示 `Local workspace sandbox is ready`。如果 namespace 创建被系统拒绝，请检查内核是否启用了非特权 user namespace。
