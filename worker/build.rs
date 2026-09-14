fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=../proto/worker.proto");
    prost_build::compile_protos(&["../proto/worker.proto"], &["../proto"])?;
    Ok(())
}
