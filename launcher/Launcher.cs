// Inicializador da Central de Campanhas. Compilado por scripts/build-exe.mjs,
// que grava o caminho do projeto no lugar de @@ROOT@@. Não contém lógica de
// negócio: só localiza o Node e executa scripts/launcher.mjs numa janela visível.
using System;
using System.Diagnostics;
using System.IO;

static class Launcher
{
    const string Root = @"@@ROOT@@";

    static int Main()
    {
        Console.Title = "Central de Campanhas";
        try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }

        var script = Path.Combine(Root, "scripts", "launcher.mjs");
        if (!File.Exists(script))
            return Falha("Projeto não encontrado em:\n  " + Root +
                         "\n\nSe você moveu a pasta, recompile o executável com: npm.cmd run build:exe");

        var node = LocalizarNode();
        if (node == null)
            return Falha("Node.js não encontrado.\n\nInstale a versão 22 ou superior em https://nodejs.org");

        var info = new ProcessStartInfo(node, "\"" + script + "\"")
        {
            WorkingDirectory = Root,
            UseShellExecute = false
        };
        int codigo;
        try
        {
            using (var p = Process.Start(info)) { p.WaitForExit(); codigo = p.ExitCode; }
        }
        catch (Exception e) { return Falha("Não foi possível iniciar o Node.js:\n  " + e.Message); }

        // Erro: segura a janela para o usuário conseguir ler a mensagem.
        if (codigo != 0)
        {
            Console.WriteLine("\nO sistema não iniciou (código " + codigo + "). Pressione qualquer tecla para fechar.");
            Pausar();
        }
        return codigo;
    }

    // ReadKey lança exceção quando não há console interativo (ex.: execução por script).
    static void Pausar() { try { Console.ReadKey(true); } catch (InvalidOperationException) { } }

    static string LocalizarNode()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try { var f = Path.Combine(dir.Trim('"'), "node.exe"); if (File.Exists(f)) return f; } catch { }
        }
        foreach (var raiz in new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)"), Environment.GetEnvironmentVariable("LOCALAPPDATA") + @"\Programs" })
        {
            if (string.IsNullOrEmpty(raiz)) continue;
            var f = Path.Combine(raiz, "nodejs", "node.exe");
            if (File.Exists(f)) return f;
        }
        return null;
    }

    static int Falha(string mensagem)
    {
        Console.WriteLine("\n  ✖  " + mensagem.Replace("\n", "\n     "));
        Console.WriteLine("\nPressione qualquer tecla para fechar.");
        Pausar();
        return 1;
    }
}
