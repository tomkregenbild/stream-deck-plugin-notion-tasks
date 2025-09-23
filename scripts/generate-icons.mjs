#!/usr/bin/env node

import { iconLogoNotion } from "@elgato/icons/l";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";

async function generateIcons() {
    const pluginDir = path.join(process.cwd(), "com.tom-kregenbild.notion-tasks.sdPlugin");
    const imgsDir = path.join(pluginDir, "imgs");
    const pluginImgsDir = path.join(imgsDir, "plugin");
    
    // Ensure the directories exist
    await fs.mkdir(pluginImgsDir, { recursive: true });
    
    // Generate marketplace icons (128x128 and 256x256)
    console.log("Generating marketplace icons...");
    await generateIcon(iconLogoNotion, path.join(pluginImgsDir, "marketplace.png"), 128);
    await generateIcon(iconLogoNotion, path.join(pluginImgsDir, "marketplace@2x.png"), 256);
    
    // Generate category icons (28x28 and 56x56) with white foreground and transparent background
    console.log("Generating category icons...");
    await generateCategoryIcon(iconLogoNotion, path.join(pluginImgsDir, "category-icon.png"), 28);
    await generateCategoryIcon(iconLogoNotion, path.join(pluginImgsDir, "category-icon@2x.png"), 56);
    
    // Generate action icons (72x72 and 144x144)
    console.log("Generating action icons...");
    await generateIcon(iconLogoNotion, path.join(imgsDir, "actionIcon.png"), 72);
    await generateIcon(iconLogoNotion, path.join(imgsDir, "actionIcon@2x.png"), 144);
    
    console.log("Icons generated successfully!");
}

async function generateIcon(svgIcon, outputPath, size) {
    // Extract the path content from the SVG icon
    const pathMatch = svgIcon.match(/<path[^>]*d="([^"]*)"[^>]*>/);
    const pathData = pathMatch ? pathMatch[1] : '';
    
    // Create SVG with white fill for better visibility
    const svgContent = `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="${pathData}" fill="#FFFFFF" fill-rule="evenodd" clip-rule="evenodd"/>
        </svg>
    `;
    
    await sharp(Buffer.from(svgContent))
        .resize(size, size)
        .png()
        .toFile(outputPath);
    
    console.log(`Generated: ${outputPath}`);
}

async function generateCategoryIcon(svgIcon, outputPath, size) {
    // Extract the path content from the SVG icon
    const pathMatch = svgIcon.match(/<path[^>]*d="([^"]*)"[^>]*>/);
    const pathData = pathMatch ? pathMatch[1] : '';
    
    // Create SVG with white foreground and transparent background for category icon
    const svgContent = `
        <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="${pathData}" fill="#FFFFFF" fill-rule="evenodd" clip-rule="evenodd"/>
        </svg>
    `;
    
    await sharp(Buffer.from(svgContent))
        .resize(size, size)
        .png()
        .toFile(outputPath);
    
    console.log(`Generated: ${outputPath}`);
}

// Run the script
generateIcons().catch(console.error);