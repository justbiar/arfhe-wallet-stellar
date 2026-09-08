#!/usr/bin/env python3
import os
import subprocess
import sys

# --- RENKLİ ÇIKTILAR İÇİN ---
class Colors:
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RED = '\033[91m'
    RESET = '\033[0m'

def run_cmd(cmd):
    """Komutu çalıştırır ve çıktısını döndürür."""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result

def get_current_branch():
    """Mevcut Git dalını (branch) bulur."""
    res = run_cmd("git branch --show-current")
    return res.stdout.strip() if res.returncode == 0 else "main"

def generate_commit_message(file_path, status_code):
    """Dosya uzantısına ve Git durumuna göre akıllı bir commit mesajı üretir."""
    filename = os.path.basename(file_path)
    ext = os.path.splitext(filename)[1].lower()
    
    # Eylem (Action) belirleme
    action = "Update"
    if status_code == "??" or status_code.startswith("A"):
        action = "Add new"
    elif status_code.startswith("D"):
        action = "Remove"
        
    # Dosya ismine/uzantısına göre bağlam (Context) belirleme
    if filename in ["package.json", "package-lock.json", "requirements.txt", "Cargo.toml"]:
        return f"{action} project dependencies/scripts in {filename}"
    if filename.lower() == "readme.md":
        return f"{action} project documentation in README"
    if filename.endswith(".gitignore"):
        return f"{action} git ignore rules"
        
    if ext in [".js", ".ts", ".py", ".rs", ".go", ".java", ".cpp", ".c"]:
        return f"{action} backend/core logic in {filename}"
    if ext in [".tsx", ".jsx", ".html", ".vue", ".svelte"]:
        return f"{action} UI component {filename}"
    if ext in [".css", ".scss", ".tailwind"]:
        return f"{action} styling in {filename}"
    if ext in [".sol"]:
        return f"{action} smart contract {filename}"
    if ext in [".json", ".yaml", ".yml", ".toml", ".env"]:
        return f"{action} configuration settings in {filename}"
    if ext in [".md", ".txt"]:
        return f"{action} documentation file {filename}"
    if "test" in file_path.lower() or "spec" in file_path.lower():
        return f"{action} unit tests in {filename}"
        
    return f"{action} {filename}"

def main():
    print(f"{Colors.BLUE}🚀 Atomic Git Pusher Başlatılıyor...{Colors.RESET}")
    
    # Git reposu mu kontrol et
    if run_cmd("git rev-parse --is-inside-work-tree").returncode != 0:
        print(f"{Colors.RED}Hata: Burası bir Git klasörü değil!{Colors.RESET}")
        sys.exit(1)

    branch = get_current_branch()
    print(f"{Colors.YELLOW}Mevcut Dal (Branch): {branch}{Colors.RESET}\n")

    # Değişen veya yeni eklenen dosyaları al (Porcelain formatı okunması kolaydır)
    status_res = run_cmd("git status --porcelain")
    if not status_res.stdout.strip():
        print(f"{Colors.GREEN}Herhangi bir değişiklik bulunamadı. Çalışma dizini temiz!{Colors.RESET}")
        sys.exit(0)

    lines = status_res.stdout.strip().split('\n')
    
    files_to_process = []
    for line in lines:
        if len(line) < 3: continue
        status_code = line[:2]
        # Tırnak işaretleri varsa temizle (boşluklu dosya isimleri için)
        file_path = line[3:].strip().strip('"') 
        files_to_process.append((file_path, status_code))

    total = len(files_to_process)
    print(f"Toplam {total} adet değişen/yeni dosya bulundu.\n")

    for i, (file_path, status_code) in enumerate(files_to_process, 1):
        msg = generate_commit_message(file_path, status_code)
        print(f"{Colors.BLUE}[{i}/{total}] İşleniyor: {file_path}{Colors.RESET}")
        print(f"       Mesaj: {msg}")
        
        # 1. Ekle (Add)
        run_cmd(f'git add "{file_path}"')
        
        # 2. Commit
        safe_msg = msg.replace('"', '\\"') # Tırnakları kaçış karakteriyle koruyalım
        commit_res = run_cmd(f'git commit -m "{safe_msg}"')
        
        if commit_res.returncode != 0:
            print(f"       {Colors.RED}Commit atlanıyor (Zaten eklenmiş veya değişiklik yok).{Colors.RESET}")
            continue
            
        # 3. Push
        push_res = run_cmd(f'git push origin {branch}')
        if push_res.returncode != 0:
             print(f"       {Colors.RED}Push hatası! İnternet veya yetki sorunu olabilir.{Colors.RESET}")
        else:
             print(f"       {Colors.GREEN}✔ Başarıyla pushlandı!{Colors.RESET}")

    print(f"\n{Colors.GREEN}🎉 Bütün dosyalar ayrı ayrı commitlenip '{branch}' dalına pushlandı!{Colors.RESET}")

if __name__ == "__main__":
    main()