use rollio_robot_airbot_eef::{run_with_profile, DriverProfile};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    if let Err(error) = run_with_profile(DriverProfile::G2).await {
        eprintln!("rollio-robot-airbot-g2: {error}");
        std::process::exit(1);
    }
}
