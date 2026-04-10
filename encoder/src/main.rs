use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "rollio-encoder")]
#[command(about = "Video/depth encoder for Sprint 4")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Probe(rollio_encoder::probe::ProbeArgs),
    Run(rollio_encoder::runtime::RunArgs),
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Probe(args) => rollio_encoder::probe::run(args)?,
        Command::Run(args) => rollio_encoder::runtime::run(args)?,
    }
    Ok(())
}
